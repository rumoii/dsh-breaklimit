import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

export const REPOSITORY = 'rumoii/dsh-breaklimit'
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u
const SHA = /^[0-9a-f]{40}$/u
const REQUIRED = ['LICENSE', 'README.md', 'src/plugin.js', 'src/client.js', 'src/cli.js', 'src/bundle.yml', 'src/context/inject.md', 'test/cli.test.js']

export function run(file, args, options = {}) {
  return execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000, maxBuffer: 128 * 1024 * 1024, ...options })
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function readJson(read, name) {
  try { return JSON.parse(read(name)) } catch { throw new Error(`${name}: missing or malformed JSON`) }
}

function sourceInfo(read) {
  const pkg = readJson(read, 'package.json')
  if (!VERSION.test(pkg.version)) throw new Error('package.json: invalid version')
  const changelog = read('CHANGELOG.md')
  if (!changelog.split(/\r?\n/u).some(line => line === `## ${pkg.version}` || line.startsWith(`## ${pkg.version} `))) {
    throw new Error(`CHANGELOG.md: missing ## ${pkg.version}`)
  }
  const hashes = readJson(read, 'src/patch/hashes.json')
  if (!hashes.dsh || hashes.dsh.version !== pkg.engines?.dsh || !SHA.test(hashes.dsh.commit)) {
    throw new Error('package.json engines.dsh does not match src/patch/hashes.json')
  }
  for (const name of REQUIRED) {
    if (!read(name).trim()) throw new Error(`${name}: required release file is empty`)
  }
  return { version: pkg.version, host: hashes.dsh }
}

export function checkSource(root = '.') {
  return sourceInfo(name => fs.readFileSync(path.join(root, name), 'utf8'))
}

export function resolveCandidate(repo, tag, expectedSha) {
  if (!/^v/u.test(tag) || !VERSION.test(tag.slice(1))) throw new Error('invalid release tag')
  if (!SHA.test(expectedSha)) throw new Error('expected SHA must contain 40 lowercase hexadecimal characters')
  let sourceSha
  try {
    sourceSha = run('git', ['-C', repo, 'rev-parse', '--verify', `refs/tags/${tag}^{commit}`]).trim()
  } catch { throw new Error(`release tag not found: ${tag}`) }
  if (sourceSha !== expectedSha) throw new Error(`tag SHA mismatch: ${tag} is ${sourceSha}, expected ${expectedSha}`)
  try { run('git', ['-C', repo, 'merge-base', '--is-ancestor', sourceSha, 'refs/remotes/origin/main']) } catch {
    throw new Error('release commit is not on origin/main; fetch and land the candidate before tagging')
  }
  const info = sourceInfo(name => run('git', ['-C', repo, 'show', `${sourceSha}:${name}`]))
  if (tag !== `v${info.version}`) throw new Error('tag version does not match package.json version')
  const tree = run('git', ['-C', repo, 'ls-tree', '-rz', sourceSha])
  for (const entry of tree.split('\0').filter(Boolean)) {
    const [mode, name] = [entry.slice(0, 6), entry.slice(entry.indexOf('\t') + 1)]
    if (!['100644', '100755'].includes(mode) || name.split('/').some(part => ['..', '.git'].includes(part)) || /[\\:]/u.test(name)) {
      throw new Error(`unsupported archive entry: ${name}`)
    }
  }
  return { format: 1, repository: REPOSITORY, tag, sourceSha, ...info }
}

function releaseFiles(repo, metadata) {
  const name = `dsh-breaklimit-${metadata.version}.zip`
  // ZIP timestamps use local time. Fix UTC and avoid compression for reproducible bytes.
  const archive = run('git', ['-C', repo, 'archive', '-0', '--format=zip', `--prefix=dsh-breaklimit-${metadata.version}/`, metadata.sourceSha], { encoding: 'buffer', env: { ...process.env, TZ: 'UTC0' } })
  const files = new Map([
    [name, archive],
    ['release-metadata.json', Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`)],
  ])
  files.set('SHA256SUMS.txt', Buffer.from([...files].map(([file, bytes]) => `${sha256(bytes)}  ${file}\n`).join('')))
  return files
}

export function verifyRelease(repo, tag, expectedSha, directory) {
  const metadata = resolveCandidate(repo, tag, expectedSha)
  const expected = releaseFiles(repo, metadata)
  const actual = fs.readdirSync(directory).sort()
  if (JSON.stringify(actual) !== JSON.stringify([...expected.keys()].sort())) throw new Error('发布附件集合不完整或包含多余文件')
  for (const [name, bytes] of expected) {
    const file = path.join(directory, name)
    if (!fs.lstatSync(file).isFile()) throw new Error(`${name}: attachment must be a regular file`)
    if (!fs.readFileSync(file).equals(bytes)) throw new Error(`${name}: 内容或哈希不符，来源不是指定提交`)
  }
  return metadata
}

export function packRelease(repo, tag, expectedSha, directory) {
  const metadata = resolveCandidate(repo, tag, expectedSha)
  if (fs.existsSync(directory) && fs.readdirSync(directory).length > 0) {
    return verifyRelease(repo, tag, expectedSha, directory)
  }
  fs.mkdirSync(directory, { recursive: true })
  for (const [name, bytes] of releaseFiles(repo, metadata)) {
    fs.writeFileSync(path.join(directory, name), bytes, { flag: 'wx' })
  }
  return verifyRelease(repo, tag, expectedSha, directory)
}

export function extractRelease(repo, tag, expectedSha, directory, destination) {
  const metadata = verifyRelease(repo, tag, expectedSha, directory)
  if (fs.existsSync(destination)) throw new Error('extraction destination already exists; use a new directory')
  fs.mkdirSync(destination, { recursive: true })
  const archive = path.resolve(directory, `dsh-breaklimit-${metadata.version}.zip`)
  if (process.platform === 'win32') run(path.join(process.env.SystemRoot, 'System32', 'tar.exe'), ['-xf', archive, '-C', destination])
  else run('unzip', ['-q', archive, '-d', destination])
  return path.resolve(destination, `dsh-breaklimit-${metadata.version}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [command, ...args] = process.argv.slice(2)
    if (command === 'check' && args.length <= 1) console.log(JSON.stringify(checkSource(args[0]), null, 2))
    else if (command === 'pack' && args.length === 4) console.log(JSON.stringify(packRelease(...args), null, 2))
    else if (command === 'verify' && args.length === 4) console.log(JSON.stringify(verifyRelease(...args), null, 2))
    else if (command === 'extract' && args.length === 5) console.log(extractRelease(...args))
    else throw new Error('Usage: release.mjs check [root] | pack/verify <repo> <tag> <full-sha> <directory> | extract <repo> <tag> <full-sha> <directory> <new-destination>')
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
