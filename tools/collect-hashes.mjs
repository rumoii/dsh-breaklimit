// 从目标宿主的 HEAD 采集补丁目标的整文件哈希，写进 patches/hashes.json。
//
// 预哈希把「宿主的这一版」钉进声明里：Apply 之前拿它比对实时文件，不符即拒绝。
// 它换来的是两件事——升级或外部改动导致的失配变成一次显式失败，而不是打歪；
// 重复应用被识别为「已应用」而不是「再打一次」。代价是宿主每次升级都要重采。
//
// 采集源固定是 HEAD，不是工作树。工作树可能已经带着别的改动，拿它当基准会让
// 预检对着一个已经偏离的版本宣称通过。
//
// 归属校验：采集前先比对宿主 HEAD 与 DSH_TARGET.commit，不是同一份提交就报错
// 退出、不生成哈希表。此前 dsh 块永远写死 DSH_TARGET 的版本与提交，与实际采样
// 的树无关，于是从别的树采来的哈希表会被 reconcile 当成「给这棵树采的」（假绿），
// 直到真机预检才报「预哈希不符」。现在记录里的 dsh.commit 写实际采样来源（校验
// 保证它与 DSH_TARGET.commit 是同一份），归属与事实一致。
//
// 用法: node tools/collect-hashes.mjs <宿主根>
// 退出码: 0 已生成；1 归属校验失败（宿主 HEAD 与 DSH_TARGET.commit 不是同一份）；
//         2 用法或环境错误（缺参数、宿主 HEAD 读不到）。

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { DSH_TARGET, PATCHES } from '../src/patch/index.js'

/**
 * 归属校验：采样树必须正是 DSH_TARGET 钉住的那份提交。
 *
 * @param {string} head - 采样树的完整 HEAD。
 * @returns {string | null} 不属于时返回报错文案，属于时返回 null。
 */
export function ownershipMismatch(head) {
  if (head === DSH_TARGET.commit) return null
  return `宿主 HEAD ${head} 与 DSH_TARGET.commit ${DSH_TARGET.commit} 不是同一份提交，拒绝生成哈希表：`
    + '归属不明的哈希表会被 reconcile 当成对的（假绿），真机预检才会报「预哈希不符」。'
}

/**
 * 组装哈希表负载。dsh 块写实际采样来源，不再写死声明值；调用方已用
 * ownershipMismatch 保证它与 DSH_TARGET.commit 是同一份提交。
 *
 * @param {string} head - 实际采样的宿主 HEAD（完整 SHA）。
 * @param {Record<string, Record<string, string>>} files - 补丁 → 目标路径 → 哈希。
 * @param {string} [generatedAt] - 采集时间，测试可注入固定值。
 */
export function buildHashesPayload(head, files, generatedAt = new Date().toISOString()) {
  return {
    dsh: { version: DSH_TARGET.version, commit: head },
    generatedAt,
    note: '由 tools/collect-hashes.mjs 从宿主 HEAD 生成。手工编辑会让预检与目标版本脱节。',
    files,
  }
}

function main() {
  const hostRoot = process.argv[2]
  if (hostRoot === undefined || hostRoot === '') {
    console.error('用法: node tools/collect-hashes.mjs <宿主根>')
    process.exit(2)
  }

  function git(args) {
    return execFileSync('git', ['-C', hostRoot, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  }

  let head
  try {
    head = git(['rev-parse', 'HEAD']).trim()
  } catch (error) {
    console.error(`无法读取 ${hostRoot} 的 HEAD：${String(error?.message ?? error)}`)
    process.exit(2)
  }

  // 采集前先验归属：错树在这里停下，什么也不写。
  const mismatch = ownershipMismatch(head)
  if (mismatch !== null) {
    console.error(mismatch)
    process.exit(1)
  }

  const files = {}
  let collected = 0
  let skipped = 0

  for (const patch of PATCHES) {
    for (const target of patch.targets) {
      let content
      try {
        content = git(['show', `HEAD:${target.path}`])
      } catch {
        console.error(`跳过（HEAD 中不存在）：${target.path}`)
        skipped += 1
        continue
      }
      const hash = `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`
      if (files[patch.id] === undefined) files[patch.id] = {}
      files[patch.id][target.path] = hash
      collected += 1
    }
  }

  const destination = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'patch', 'hashes.json')
  fs.writeFileSync(destination, `${JSON.stringify(buildHashesPayload(head, files), null, 2)}\n`, 'utf8')

  console.log(`已写入 ${destination}`)
  console.log(`采集 ${String(collected)} 条，跳过 ${String(skipped)} 条`)
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) main()
