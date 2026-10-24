// 检查更新。
//
// 与 streamfirefly 的 update-check.js 同构：版本比较、每天一次、并发去重、忽略版本、
// 失败保留上次结果。差异只在出网——那边跑在浏览器扩展里，系统代理由浏览器代劳；
// 这边跑在宿主的 Node 进程里，fetch 不读 HTTPS_PROXY，所以自己解析代理并在需要时
// 走 CONNECT 隧道。保持零依赖，不引入 undici。

import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { breaklimitDir } from '../patch/state.js'
import { atomicWrite, decodeUtf8, readBytesStrict } from '../patch/fsx.js'
import { acquireFileLock, releaseFileLock } from '../patch/lock.js'

export const REPO = 'rumoii/dsh-breaklimit'
export const RELEASES_URL = `https://github.com/${REPO}/releases/latest`

// 发布列表而不是 releases/latest：后者只认「最新的正式版」，内测版全是 pre-release，
// 在只有内测版的仓库上永远 404。列表接口按创建时间倒序，这里再按版本号取最大，
// 不依赖服务端的排序。
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases?per_page=10`
const RELEASE_PREFIX = `https://github.com/${REPO}/releases/`
const PACKAGE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 带错误码的上游错误，接口层据此挑状态码与文案。 */
export class UpdateError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

/**
 * 解析 `x.y.z`（允许 `v` 前缀）。
 *
 * @param {unknown} value - 待解析的版本串。
 * @returns {number[] | null} 三段数字；不是三段版本时返回 null。
 */
export function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(value ?? '').trim())
  return match ? match.slice(1).map(Number) : null
}

/**
 * 判断 latest 是否比 current 新。任一位置解析不出来都算「没有更新」，不猜。
 *
 * @param {unknown} latest - 远端的版本串。
 * @param {unknown} current - 本地的版本串。
 * @returns {boolean} 远端更新的位置存在且值更大时为 true。
 */
export function isNewerVersion(latest, current) {
  const next = parseVersion(latest)
  const installed = parseVersion(current)
  if (next === null || installed === null) return false
  const index = next.findIndex((part, position) => part !== installed[position])
  return index >= 0 && next[index] > installed[index]
}

/** 本地日期 `YYYY-MM-DD`，用本地时区，跨天判断与用户感知一致。 */
export function localDay(date = new Date()) {
  const pad = value => String(value).padStart(2, '0')
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** @returns {string} 更新状态文件路径。 */
export function updateStatePath(home) {
  return path.join(breaklimitDir(home), 'update.json')
}

const STATE_FIELDS = ['autoCheckUpdates', 'lastAutoCheckDay', 'latestVersion', 'releaseUrl', 'checkedAt', 'dismissedVersion']

/**
 * 读取更新状态。缺文件、JSON 损坏、字段类型不对都回落到空对象，不抛错——
 * 与 tiers.readTier 的契约一致：一个显示用的状态不该让整个面板打不开。
 *
 * @param {string} home - $DSH_HOME 路径。
 * @returns {{ kind: 'ok' | 'default' | 'corrupt', state: object }} 解析结果与状态。
 */
export function readUpdateState(home) {
  const read = readBytesStrict(updateStatePath(home))
  if (read.kind === 'missing') return { kind: 'default', state: {} }
  if (read.kind === 'unreadable') return { kind: 'unreadable', state: {} }
  const raw = decodeUtf8(read.bytes)
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { kind: 'corrupt', state: {} }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'corrupt', state: {} }
  const state = {}
  for (const field of STATE_FIELDS) {
    const value = parsed[field]
    if (field === 'autoCheckUpdates') {
      if (typeof value === 'boolean') state[field] = value
    } else if (field === 'checkedAt') {
      if (typeof value === 'number' && Number.isFinite(value)) state[field] = value
    } else if (typeof value === 'string' && value.trim() !== '') {
      state[field] = value
    }
  }
  return { kind: 'ok', state }
}

// 写入锁的事务 id 计数：同一进程里 HTTP 与命令各自拿各自的 id。
let lockSequence = 0

/** 锁被占用时的结构化失败。本域的失败通道就是抛错，code 供调用方分支。 */
function lockBusyError(conflict) {
  const holder = conflict?.holder ?? null
  const who = holder === null
    ? '另一个操作'
    : `另一个操作（${String(holder.operationId ?? '未知事务')}，pid ${String(holder.pid ?? '未知')}）`
  const error = new Error(`更新状态正在被${who}占用，本次写入已取消`)
  error.code = 'locked'
  error.lockPath = conflict?.path
  return error
}

/**
 * 在跨进程锁内跑一段同步的「读-改-写」临界区。
 *
 * 锁文件与补丁事务、规则写入共用 `$DSH_HOME/breaklimit/operation.lock`：改的都是
 * 同一个 DSH_HOME，互相排斥本来就是对的。锁被占用时立即抛 code 为 'locked' 的
 * 错误，不排队——autoCheck 把它收进 lastError，HTTP 层走既有的抛错出口。
 *
 * @param {string} home - $DSH_HOME 路径。
 * @param {string} operation - 操作名，进事务 id 便于排查。
 * @param {() => object} run - 同步临界区。
 */
function withUpdateLock(home, operation, run) {
  lockSequence += 1
  const operationId = `update-${operation}-${process.pid.toString(36)}-${String(lockSequence)}`
  // acquireFileLock 抛出时没有本次建出的东西可清（lock.js 自己收干净）；
  // run 抛出时 finally 保证释放。
  const handle = acquireFileLock(home, operationId)
  if (handle.conflict !== undefined) throw lockBusyError(handle.conflict)
  try {
    return run()
  } finally {
    releaseFileLock(handle)
  }
}

/**
 * 合并写入更新状态。写 lastAutoCheckDay 不能把 latestVersion 抹掉，所以是合并不是替换。
 * 读-改-写在跨进程锁内完成：多个进程共享同一 $DSH_HOME 时不会互相覆盖字段。
 * 锁被占用时抛 code 为 'locked' 的错误，不动文件。
 *
 * @param {string} home - $DSH_HOME 路径。
 * @param {object} patch - 要更新的字段。
 * @returns {object} 合并后的状态。
 */
export function writeUpdateState(home, patch) {
  return withUpdateLock(home, 'write', () => {
    const current = readUpdateState(home)
    // 损坏的文件里可能存着「关闭自动检查」这类偏好：先按 rules.json 的恢复先例备份，
    // 备份不成就不写——宁可留在损坏态，也不把用户的选择悄悄抹掉。
    if (current.kind === 'unreadable') {
      const error = new Error('更新偏好读不到，已拒绝覆盖。')
      error.code = 'state_unreadable'
      throw error
    }
    if (current.kind === 'corrupt') backUpCorruptState(home)
    const next = { ...current.state, ...patch }
    atomicWrite(updateStatePath(home), `${JSON.stringify(next, null, 2)}\n`)
    return next
  })
}

/**
 * 把损坏的 update.json 备份到 $DSH_HOME/dsh-breaklimit-backup/<时间戳>/update.json。
 * 与规则恢复的备份同一套纪律：字节核对、同秒撞名用随机后缀、任何失败都不动原文件。
 *
 * @param {string} home - $DSH_HOME 路径。
 */
function backUpCorruptState(home) {
  const file = updateStatePath(home)
  const original = fs.readFileSync(file)
  // 目录名用本地时间：用户是照着自己看到的时间去磁盘上找的。
  const now = new Date()
  const pad = value => String(value).padStart(2, '0')
  const stamp = `${String(now.getFullYear())}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const backupRoot = path.join(home, 'dsh-breaklimit-backup')
  let backupDir = null
  try {
    fs.mkdirSync(backupRoot, { recursive: true })
    const preferred = path.join(backupRoot, stamp)
    try {
      fs.mkdirSync(preferred)
      backupDir = preferred
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      backupDir = fs.mkdtempSync(`${preferred}-`)
    }
    const backupFile = path.join(backupDir, 'update.json')
    fs.copyFileSync(file, backupFile, fs.constants.COPYFILE_EXCL)
    if (!fs.readFileSync(backupFile).equals(original)) throw new Error('备份字节与原文件不符')
    if (!fs.readFileSync(file).equals(original)) throw new Error('原文件在备份期间被改动')
  } catch (error) {
    try {
      if (backupDir !== null) fs.rmSync(backupDir, { recursive: true, force: true })
    } catch {
      // 清理失败不盖住原始错误。
    }
    throw new Error(`备份损坏的更新状态失败：${String(error?.message ?? error)}`)
  }
}

/** 自动检查是否开启。字段缺省视为开启——新装用户默认用上这个功能。 */
export function isAutoCheckOn(state) {
  return state?.autoCheckUpdates !== false
}

/**
 * 读插件自身的版本号。前端顶栏用的是硬编码常量，两处由测试守同步。
 *
 * @param {string} [packageRoot] - 包根目录，测试可注入。
 * @returns {string} 版本串；读不出来时返回空串。
 */
export function readInstalledVersion(packageRoot = PACKAGE_ROOT) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
    return typeof pkg?.version === 'string' ? pkg.version : ''
  } catch {
    return ''
  }
}

let gitProxyCache

/** 读 git 的 http.proxy。只读命令，1 秒超时，失败一律当没配。 */
function readGitProxy() {
  if (gitProxyCache !== undefined) return gitProxyCache
  try {
    const out = execFileSync('git', ['config', '--get', 'http.proxy'], {
      encoding: 'utf8',
      timeout: 1000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const trimmed = String(out ?? '').trim()
    gitProxyCache = trimmed === '' ? null : trimmed
  } catch {
    gitProxyCache = null
  }
  return gitProxyCache
}

/** 测试用：清掉进程内缓存的 git 代理。 */
export function resetProxyCache() {
  gitProxyCache = undefined
}

/**
 * 解析出口代理。环境变量优先（宿主会把 $DSH_HOME/.env 里的 HTTPS_PROXY 注入进程），
 * 其次读 git 的 http.proxy——本机 git 能推代码，说明那个代理是通的。
 *
 * @param {object} [deps] - 注入点，测试用。
 * @returns {string | null} 代理地址；都没有时 null，表示直连。
 */
export function resolveProxy({ env = process.env, gitProxy = readGitProxy } = {}) {
  const fromEnv = env.HTTPS_PROXY ?? env.https_proxy ?? env.ALL_PROXY ?? env.all_proxy ?? env.HTTP_PROXY ?? env.http_proxy
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  const fromGit = gitProxy()
  return typeof fromGit === 'string' && fromGit.trim() !== '' ? fromGit.trim() : null
}

/** 代理来源，只回标识不回地址——地址可能带凭据。 */
export function proxySource({ env = process.env, gitProxy = readGitProxy } = {}) {
  const fromEnv = env.HTTPS_PROXY ?? env.https_proxy ?? env.ALL_PROXY ?? env.all_proxy ?? env.HTTP_PROXY ?? env.http_proxy
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return 'env'
  const fromGit = gitProxy()
  return typeof fromGit === 'string' && fromGit.trim() !== '' ? 'git' : null
}

function proxyAuthHeader(proxy) {
  if (proxy.username === '' && proxy.password === '') return null
  const user = decodeURIComponent(proxy.username)
  const pass = decodeURIComponent(proxy.password)
  return `Basic ${Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')}`
}

/**
 * 经 CONNECT 隧道取一次 URL。Node 的 fetch 不接受代理参数，零依赖下只能自己开隧道。
 *
 * @param {string} url - 目标地址。
 * @param {string} proxyUrl - 代理地址。
 * @param {number} timeoutMs - 整体超时。
 * @param {object} headers - 附加请求头。
 * @returns {Promise<{ status: number, text: string }>} 状态码与响应体。
 */
function requestViaProxy(url, proxyUrl, timeoutMs, headers) {
  return new Promise((resolve, reject) => {
    let target
    let proxy
    try {
      target = new URL(url)
      proxy = new URL(proxyUrl)
    } catch {
      reject(new UpdateError('update_unreachable', '代理地址或目标地址无法解析。'))
      return
    }
    if (proxy.protocol !== 'http:') {
      // CONNECT 隧道是明文建的，https:// 代理会把凭据和请求裸发到端口上，直接拒绝。
      reject(new UpdateError('update_unreachable', '只支持 http:// 代理；https:// 代理不支持，请改用 http:// 代理或直连。'))
      return
    }

    let settled = false
    let connectRequest, tunnel, upstream, responseBody, timer
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      responseBody?.destroy()
      upstream?.destroy()
      tunnel?.destroy()
      connectRequest?.destroy()
      fn(value)
    }

    let auth
    try { auth = proxyAuthHeader(proxy) } catch {
      reject(new UpdateError('update_unreachable', '代理凭据无法解析。'))
      return
    }
    timer = setTimeout(() => {
      finish(reject, new UpdateError('update_unreachable', '连接 GitHub 超时。'))
    }, timeoutMs)
    const connectHeaders = { Host: `${target.hostname}:443` }
    if (auth !== null) connectHeaders['Proxy-Authorization'] = auth

    try {
      connectRequest = http.request({
        host: proxy.hostname,
        port: proxy.port === '' ? 80 : Number(proxy.port),
        method: 'CONNECT',
        path: `${target.hostname}:443`,
        headers: connectHeaders,
      })

      connectRequest.on('connect', (response, socket) => {
        if (settled) { socket.destroy(); return }
        tunnel = socket
        if (response.statusCode !== 200) {
          socket.destroy()
          // 407 也要报成「连不上」：上层只需要知道这次检查没成。
          finish(reject, new UpdateError('update_unreachable', `代理拒绝了连接（${String(response.statusCode)}）。`))
          return
        }
        try {
          upstream = https.request({
            host: target.hostname,
            port: 443,
            servername: target.hostname,
            method: 'GET',
            path: `${target.pathname}${target.search}`,
            headers: { ...headers, Host: target.hostname },
            // agent: false 是必须的：有默认 agent 时 Node 会忽略传入的 socket 另开连接，
            // 隧道就白建了。
            agent: false,
            socket,
          }, res => {
            if (settled) { res.destroy(); return }
            responseBody = res
            const failed = () => finish(reject, new UpdateError('update_unreachable', '经代理读取响应失败。'))
            res.on('error', failed)
            res.on('aborted', failed)
            const chunks = []
            res.on('data', chunk => { chunks.push(chunk) })
            res.on('end', () => {
              finish(resolve, { status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') })
            })
          })
          upstream.on('error', () => {
            finish(reject, new UpdateError('update_unreachable', '经代理读取响应失败。'))
          })
          upstream.end()
        } catch {
          finish(reject, new UpdateError('update_unreachable', '经代理建立请求失败。'))
        }
      })

      connectRequest.on('error', () => {
        finish(reject, new UpdateError('update_unreachable', '连不上代理。'))
      })
      connectRequest.end()
    } catch {
      finish(reject, new UpdateError('update_unreachable', '连不上代理。'))
    }
  })
}

async function requestDirect(url, timeoutMs, headers, fetchImpl) {
  let response
  try {
    response = await fetchImpl(url, { headers, cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) })
  } catch {
    throw new UpdateError('update_unreachable', '连接 GitHub 超时或失败。')
  }
  let text
  try {
    text = await response.text()
  } catch {
    throw new UpdateError('update_unreachable', '读取 GitHub 响应失败。')
  }
  return { status: response.status, text }
}

/**
 * 查一次 GitHub 最新 release。
 *
 * @param {object} [options] - 注入点。
 * @param {string | null} [options.proxy] - 代理地址；null 表示直连。
 * @param {number} [options.timeoutMs] - 超时毫秒。
 * @param {Function} [options.fetchImpl] - 直连时用的 fetch，测试注入。
 * @returns {Promise<{ latestVersion: string, releaseUrl: string, checkedAt: number }>} 解析结果。
 */
export async function fetchLatestRelease({ proxy = null, timeoutMs = 8000, fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': `rumo-dsh-breaklimit/${readInstalledVersion()}` }
  const response = proxy === null
    ? await requestDirect(RELEASES_API, timeoutMs, headers, fetchImpl)
    : await requestViaProxy(RELEASES_API, proxy, timeoutMs, headers)

  // 403/429 是限流，对用户都是「这次没查到」。
  if (response.status < 200 || response.status >= 300) {
    throw new UpdateError('update_unreachable', `GitHub 返回 ${String(response.status)}。`)
  }

  let body
  try {
    body = JSON.parse(response.text)
  } catch {
    throw new UpdateError('update_invalid', 'GitHub 返回的内容不是 JSON。')
  }

  // 取版本号最大的那条，pre-release 也算——内测阶段发的全是 pre-release。
  const list = Array.isArray(body) ? body : []
  let best = null
  for (const item of list) {
    const tag = String(item?.tag_name ?? '').trim().replace(/^v/, '')
    if (parseVersion(tag) === null) continue
    if (best === null || isNewerVersion(tag, best.version)) {
      best = { version: tag, url: typeof item?.html_url === 'string' ? item.html_url : '' }
    }
  }
  if (best === null) {
    throw new UpdateError('update_invalid', '远端没有可用的版本标签。')
  }
  const releaseUrl = best.url.startsWith(RELEASE_PREFIX) ? best.url : RELEASES_URL
  return { latestVersion: best.version, releaseUrl, checkedAt: now() }
}

/**
 * 把落盘状态整理成前端直接可用的视图。
 *
 * @param {object} state - readUpdateState 给出的状态。
 * @param {string} currentVersion - 本地版本。
 * @returns {object} 视图对象。
 */
export function viewOf(state, currentVersion) {
  const latestVersion = typeof state?.latestVersion === 'string' ? state.latestVersion : ''
  const newer = latestVersion !== '' && isNewerVersion(latestVersion, currentVersion)
  const dismissed = state?.dismissedVersion === latestVersion
  return {
    currentVersion,
    latestVersion,
    releaseUrl: typeof state?.releaseUrl === 'string' && state.releaseUrl !== '' ? state.releaseUrl : RELEASES_URL,
    checkedAt: typeof state?.checkedAt === 'number' ? state.checkedAt : 0,
    lastAutoCheckDay: typeof state?.lastAutoCheckDay === 'string' ? state.lastAutoCheckDay : '',
    dismissedVersion: typeof state?.dismissedVersion === 'string' ? state.dismissedVersion : '',
    autoCheckUpdates: isAutoCheckOn(state),
    // newer 不受「忽略」影响，手动检查时用它；hasUpdate 供面板与浮窗提示。
    newer,
    hasUpdate: newer && !dismissed,
  }
}

// 同一天里两个入口（设置面板、浮窗）同时打开时共用一次在途请求。
let pendingAuto = null

/**
 * 每天最多一次的后台检查。
 *
 * 判据顺序与 streamfirefly 一致：开关关闭 → 不查；今天查过 → 不查；否则先写入今天的
 * 日期再发请求，失败保留上次结果、当天不再重试。先写日期是为了让同时打开的第二个入口
 * 不再发一次。
 *
 * @param {object} deps - 依赖。
 * @param {string} deps.home - $DSH_HOME。
 * @param {string} deps.currentVersion - 本地版本。
 * @param {Function} [deps.check] - 实际发请求的函数，测试注入。
 * @returns {Promise<object>} 视图对象，附带 lastError。
 */
export function autoCheck({ home, currentVersion, check = defaultCheck, now = () => new Date() }) {
  if (pendingAuto !== null) return pendingAuto
  pendingAuto = (async () => {
    const { kind, state } = readUpdateState(home)
    if (kind === 'unreadable' || kind === 'corrupt') return { ...viewOf(state, currentVersion), lastError: kind === 'unreadable' ? 'state_unreadable' : 'state_corrupt' }
    if (!isAutoCheckOn(state)) return { ...viewOf(state, currentVersion), lastError: null }
    const today = localDay(now())
    if (state.lastAutoCheckDay === today) return { ...viewOf(state, currentVersion), lastError: null }
    try {
      const marked = writeUpdateState(home, { lastAutoCheckDay: today })
      try {
        const result = await check()
        const next = writeUpdateState(home, result)
        return { ...viewOf(next, currentVersion), lastError: null }
      } catch (error) {
        // 失败不动 latestVersion，只是今天不再试；下次打开面板仍显示上次查到的结果。
        return { ...viewOf(marked, currentVersion), lastError: error?.code ?? 'update_unreachable' }
      }
    } catch (error) {
      // 状态写不进去（例如损坏文件备份失败）时退回读到的状态，不把面板拖垮。
      return { ...viewOf(state, currentVersion), lastError: error?.code ?? 'update_unreachable' }
    }
  })().finally(() => { pendingAuto = null })
  return pendingAuto
}

/** 测试用：清掉在途请求。 */
export function resetPendingAuto() {
  pendingAuto = null
}

function defaultCheck() {
  return fetchLatestRelease({ proxy: resolveProxy() })
}

/**
 * 手动检查。总是发请求，不受「今天查过」和「忽略此版本」影响。
 *
 * @param {object} deps - 依赖。
 * @returns {Promise<object>} 视图对象。
 */
export async function manualCheck({ home, currentVersion, check = defaultCheck }) {
  const result = await check()
  const next = writeUpdateState(home, { ...result, lastAutoCheckDay: localDay(new Date()) })
  return viewOf(next, currentVersion)
}
