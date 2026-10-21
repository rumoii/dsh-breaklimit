import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {
  UpdateError,
  autoCheck,
  fetchLatestRelease,
  isNewerVersion,
  localDay,
  manualCheck,
  parseVersion,
  proxySource,
  readUpdateState,
  resetPendingAuto,
  resolveProxy,
  updateStatePath,
  viewOf,
  writeUpdateState,
} from '../src/context/update.js'

function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bkl-update-'))
}

test('parseVersion 只认三段版本，允许 v 前缀', () => {
  assert.deepEqual(parseVersion('0.9.3'), [0, 9, 3])
  assert.deepEqual(parseVersion('v0.9.3'), [0, 9, 3])
  assert.deepEqual(parseVersion('  v1.10.0  '), [1, 10, 0])
  assert.equal(parseVersion('0.9'), null, '两段版本不接受')
  assert.equal(parseVersion('0.9.3.1'), null, '四段版本不接受')
  assert.equal(parseVersion('latest'), null)
  assert.equal(parseVersion(''), null)
  assert.equal(parseVersion(null), null)
})

test('isNewerVersion 逐段比较，任一处更大即为新', () => {
  assert.equal(isNewerVersion('0.9.4', '0.9.3'), true)
  assert.equal(isNewerVersion('0.10.0', '0.9.3'), true)
  assert.equal(isNewerVersion('1.0.0', '0.99.99'), true)
  assert.equal(isNewerVersion('0.9.3', '0.9.3'), false, '相同版本不算更新')
  assert.equal(isNewerVersion('0.9.2', '0.9.3'), false, '降级不算更新')
  assert.equal(isNewerVersion('bad', '0.9.3'), false, '解析不出来时不猜')
  assert.equal(isNewerVersion('0.9.4', ''), false)
})

test('localDay 用本地时区补零', () => {
  assert.equal(localDay(new Date(2026, 0, 5)), '2026-01-05')
  assert.equal(localDay(new Date(2026, 11, 31)), '2026-12-31')
})

test('readUpdateState：缺文件回落空状态，损坏不抛错', () => {
  const home = tempHome()
  const missing = readUpdateState(home)
  assert.equal(missing.kind, 'default')
  assert.deepEqual(missing.state, {})

  fs.mkdirSync(path.dirname(updateStatePath(home)), { recursive: true })
  fs.writeFileSync(updateStatePath(home), '{ not json', 'utf8')
  const corrupt = readUpdateState(home)
  assert.equal(corrupt.kind, 'corrupt')
  assert.deepEqual(corrupt.state, {})

  fs.writeFileSync(updateStatePath(home), '[]', 'utf8')
  assert.equal(readUpdateState(home).kind, 'corrupt', '数组也算损坏')
})

test('readUpdateState 丢弃类型不对的字段，保留合法的', () => {
  const home = tempHome()
  fs.mkdirSync(path.dirname(updateStatePath(home)), { recursive: true })
  fs.writeFileSync(updateStatePath(home), JSON.stringify({
    latestVersion: '0.9.4',
    checkedAt: 'not-a-number',
    autoCheckUpdates: 'yes',
    lastAutoCheckDay: 42,
    dismissedVersion: '',
  }), 'utf8')
  const { state } = readUpdateState(home)
  assert.equal(state.latestVersion, '0.9.4')
  assert.equal(state.checkedAt, undefined, '非数字的 checkedAt 丢掉')
  assert.equal(state.autoCheckUpdates, undefined, '非布尔的开关丢掉')
  assert.equal(state.lastAutoCheckDay, undefined)
  assert.equal(state.dismissedVersion, undefined, '空串丢掉')
})

test('writeUpdateState 是合并而不是覆盖', () => {
  const home = tempHome()
  writeUpdateState(home, { latestVersion: '0.9.4', releaseUrl: 'https://example.test/r' })
  writeUpdateState(home, { lastAutoCheckDay: '2026-01-05' })
  const { state } = readUpdateState(home)
  assert.equal(state.lastAutoCheckDay, '2026-01-05')
  assert.equal(state.latestVersion, '0.9.4', '写日期不能把版本抹掉')
  assert.equal(state.releaseUrl, 'https://example.test/r')
})

test('viewOf 区分「有新版本」与「已忽略」', () => {
  const base = { latestVersion: '0.9.4', releaseUrl: 'https://example.test/r', checkedAt: 1 }

  const fresh = viewOf(base, '0.9.3')
  assert.equal(fresh.newer, true)
  assert.equal(fresh.hasUpdate, true)
  assert.equal(fresh.autoCheckUpdates, true, '开关缺省视为开启')

  const dismissed = viewOf({ ...base, dismissedVersion: '0.9.4' }, '0.9.3')
  assert.equal(dismissed.newer, true, '忽略不影响 newer：手动检查要看真实结果')
  assert.equal(dismissed.hasUpdate, false, '忽略后不再提示')

  const same = viewOf(base, '0.9.4')
  assert.equal(same.newer, false)
  assert.equal(same.hasUpdate, false)

  const off = viewOf({ ...base, autoCheckUpdates: false }, '0.9.3')
  assert.equal(off.autoCheckUpdates, false)
})

test('fetchLatestRelease：成功时取最大版本与 release 链接', async () => {
  const calls = []
  const result = await fetchLatestRelease({
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return {
        status: 200,
        text: async () => JSON.stringify([
          { tag_name: 'v0.9.3', html_url: 'https://github.com/rumoii/dsh-breaklimit/releases/tag/v0.9.3' },
          { tag_name: 'v0.9.4', html_url: 'https://github.com/rumoii/dsh-breaklimit/releases/tag/v0.9.4' },
          { tag_name: 'nightly' },
        ]),
      }
    },
    now: () => 111,
  })
  assert.equal(result.latestVersion, '0.9.4', '要剥掉 v 前缀并取最大')
  assert.equal(result.releaseUrl, 'https://github.com/rumoii/dsh-breaklimit/releases/tag/v0.9.4')
  assert.equal(result.checkedAt, 111)
  assert.equal(calls[0].init.credentials, undefined, '不该带 cookie')
})

test('fetchLatestRelease：非本仓库的 html_url 回退到 releases/latest', async () => {
  const result = await fetchLatestRelease({
    fetchImpl: async () => ({ status: 200, text: async () => JSON.stringify([{ tag_name: '0.9.4', html_url: 'https://evil.test/x' }]) }),
  })
  assert.equal(result.releaseUrl, 'https://github.com/rumoii/dsh-breaklimit/releases/latest')
})

test('fetchLatestRelease：限流、超时、坏 JSON、没有合法标签都报错', async () => {
  await assert.rejects(
    fetchLatestRelease({ fetchImpl: async () => ({ status: 403, text: async () => '' }) }),
    error => error instanceof UpdateError && error.code === 'update_unreachable',
  )
  await assert.rejects(
    fetchLatestRelease({ fetchImpl: async () => { throw new Error('network') } }),
    error => error instanceof UpdateError && error.code === 'update_unreachable',
  )
  await assert.rejects(
    fetchLatestRelease({ fetchImpl: async () => ({ status: 200, text: async () => '<html>' }) }),
    error => error instanceof UpdateError && error.code === 'update_invalid',
  )
  await assert.rejects(
    fetchLatestRelease({ fetchImpl: async () => ({ status: 200, text: async () => '[]' }) }),
    error => error instanceof UpdateError && error.code === 'update_invalid',
  )
  await assert.rejects(
    fetchLatestRelease({ fetchImpl: async () => ({ status: 200, text: async () => JSON.stringify([{ tag_name: 'nightly' }]) }) }),
    error => error instanceof UpdateError && error.code === 'update_invalid',
  )
})

test('resolveProxy：环境变量优先，其次 git，都没有返回 null', () => {
  assert.equal(resolveProxy({ env: { HTTPS_PROXY: 'http://127.0.0.1:10808' }, gitProxy: () => 'http://git:8080' }), 'http://127.0.0.1:10808')
  assert.equal(resolveProxy({ env: { https_proxy: 'http://lower:1080' }, gitProxy: () => null }), 'http://lower:1080')
  assert.equal(resolveProxy({ env: {}, gitProxy: () => 'http://git:8080' }), 'http://git:8080')
  assert.equal(resolveProxy({ env: {}, gitProxy: () => null }), null)
  assert.equal(resolveProxy({ env: { HTTPS_PROXY: '  ' }, gitProxy: () => null }), null, '空白视为没配')
})

test('proxySource 只回来源标识，不回代理地址', () => {
  assert.equal(proxySource({ env: { HTTPS_PROXY: 'http://secret:10808' }, gitProxy: () => null }), 'env')
  assert.equal(proxySource({ env: {}, gitProxy: () => 'http://secret:10808' }), 'git')
  assert.equal(proxySource({ env: {}, gitProxy: () => null }), null)
})

test('autoCheck：同一天只查一次', async () => {
  resetPendingAuto()
  const home = tempHome()
  let calls = 0
  const check = async () => { calls += 1; return { latestVersion: '0.9.4', releaseUrl: 'https://example.test/r', checkedAt: 1 } }
  const day = () => new Date(2026, 0, 5, 10, 0, 0)

  const first = await autoCheck({ home, currentVersion: '0.9.3', check, now: day })
  assert.equal(calls, 1)
  assert.equal(first.hasUpdate, true)

  const second = await autoCheck({ home, currentVersion: '0.9.3', check, now: day })
  assert.equal(calls, 1, '同一天第二次打开不该再发请求')
  assert.equal(second.hasUpdate, true, '但仍要返回落盘的结果')

  const nextDay = await autoCheck({ home, currentVersion: '0.9.3', check, now: () => new Date(2026, 0, 6, 9, 0, 0) })
  assert.equal(calls, 2, '跨天要重新查')
  assert.equal(nextDay.hasUpdate, true)
})

test('autoCheck：并发的两个入口共用一次在途请求', async () => {
  resetPendingAuto()
  const home = tempHome()
  let calls = 0
  const check = async () => {
    calls += 1
    await new Promise(resolve => setTimeout(resolve, 5))
    return { latestVersion: '0.9.4', releaseUrl: 'https://example.test/r', checkedAt: 1 }
  }
  const [a, b] = await Promise.all([
    autoCheck({ home, currentVersion: '0.9.3', check }),
    autoCheck({ home, currentVersion: '0.9.3', check }),
  ])
  assert.equal(calls, 1, '设置面板与浮窗同时打开只发一次')
  assert.equal(a.latestVersion, b.latestVersion)
})

test('autoCheck：失败保留上次结果，当天不再重试', async () => {
  resetPendingAuto()
  const home = tempHome()
  writeUpdateState(home, { latestVersion: '0.9.4', releaseUrl: 'https://example.test/r', checkedAt: 7 })

  let calls = 0
  const failing = async () => { calls += 1; throw new UpdateError('update_unreachable', 'boom') }
  const day = () => new Date(2026, 1, 1, 8, 0, 0)

  const first = await autoCheck({ home, currentVersion: '0.9.3', check: failing, now: day })
  assert.equal(first.latestVersion, '0.9.4', '失败不能把上次的结果抹掉')
  assert.equal(first.lastError, 'update_unreachable')

  const again = await autoCheck({ home, currentVersion: '0.9.3', check: failing, now: day })
  assert.equal(calls, 1, '当天失败后不再重试')

  const { state } = readUpdateState(home)
  assert.equal(state.lastAutoCheckDay, '2026-02-01', '日期在请求前就写好了')
})

test('autoCheck：开关关闭时不发请求', async () => {
  resetPendingAuto()
  const home = tempHome()
  writeUpdateState(home, { autoCheckUpdates: false, latestVersion: '0.9.4', checkedAt: 3 })
  let calls = 0
  const result = await autoCheck({ home, currentVersion: '0.9.3', check: async () => { calls += 1; return {} } })
  assert.equal(calls, 0, '关闭后不该联网')
  assert.equal(result.autoCheckUpdates, false)
  assert.equal(result.latestVersion, '0.9.4', '仍返回缓存结果')
})

test('manualCheck 不受「今天查过」影响，并刷新日期', async () => {
  resetPendingAuto()
  const home = tempHome()
  writeUpdateState(home, { lastAutoCheckDay: localDay() })
  let calls = 0
  const result = await manualCheck({
    home,
    currentVersion: '0.9.3',
    check: async () => { calls += 1; return { latestVersion: '0.9.5', releaseUrl: 'https://example.test/r', checkedAt: 9 } },
  })
  assert.equal(calls, 1, '手动检查随时生效')
  assert.equal(result.latestVersion, '0.9.5')
})

test('writeUpdateState：发现损坏的 update.json 先备份再重建', () => {
  const home = tempHome()
  fs.mkdirSync(path.dirname(updateStatePath(home)), { recursive: true })
  fs.writeFileSync(updateStatePath(home), '{ not json', 'utf8')

  writeUpdateState(home, { lastAutoCheckDay: '2026-03-01' })

  assert.equal(readUpdateState(home).kind, 'ok')
  const backupRoot = path.join(home, 'dsh-breaklimit-backup')
  const dirs = fs.readdirSync(backupRoot)
  assert.equal(dirs.length, 1, '损坏内容要留一份备份')
  assert.equal(
    fs.readFileSync(path.join(backupRoot, dirs[0], 'update.json'), 'utf8'),
    '{ not json',
    '备份必须逐字节保留损坏内容',
  )
})

test('writeUpdateState：备份失败时拒绝写入，损坏文件一个字节都不动', () => {
  const home = tempHome()
  fs.mkdirSync(path.dirname(updateStatePath(home)), { recursive: true })
  fs.writeFileSync(updateStatePath(home), '{ not json', 'utf8')
  fs.writeFileSync(path.join(home, 'dsh-breaklimit-backup'), '占位成文件，让备份目录建不出来', 'utf8')

  assert.throws(() => writeUpdateState(home, { lastAutoCheckDay: '2026-03-01' }))
  assert.equal(fs.readFileSync(updateStatePath(home), 'utf8'), '{ not json')
})

test('fetchLatestRelease：拒绝 https:// 代理，不把它当明文用', async () => {
  await assert.rejects(
    fetchLatestRelease({ proxy: 'https://127.0.0.1:1' }),
    error => error instanceof UpdateError && error.code === 'update_unreachable' && error.message.includes('只支持'),
  )
})

test('fetchLatestRelease：连不上代理时报 update_unreachable', async () => {
  await assert.rejects(
    fetchLatestRelease({ proxy: 'http://127.0.0.1:1' }),
    error => error instanceof UpdateError && error.code === 'update_unreachable',
  )
})

test('fetchLatestRelease：代理 CONNECT 被拒时报状态码，请求头带 Proxy-Authorization', async () => {
  const seen = []
  const server = http.createServer()
  server.on('connect', (request, socket) => {
    seen.push({ url: request.url, headers: request.headers })
    socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    await assert.rejects(
      fetchLatestRelease({ proxy: `http://user:pass@127.0.0.1:${String(server.address().port)}` }),
      error => error instanceof UpdateError && error.code === 'update_unreachable' && error.message.includes('407'),
    )
  } finally {
    server.close()
  }
  assert.equal(seen.length, 1)
  assert.equal(seen[0].url, 'api.github.com:443')
  assert.equal(seen[0].headers['proxy-authorization'], 'Basic dXNlcjpwYXNz')
})
