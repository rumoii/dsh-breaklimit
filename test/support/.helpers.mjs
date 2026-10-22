// 共享测试支撑，本身不是测试文件。
//
// node --test 的默认拾取模式把 **/test/**/*.?(c|m)js 整棵 test/ 目录都当测试文件
// （Node 24.22.1 实测：test/support/helpers.mjs 会被当零测试文件执行），带点前缀的
// 文件名不进 glob 匹配（同实测）。所以这里叫 .helpers.mjs：既留在 test/support 下，
// 又不被 node --test 拾取，只以 import 方式使用。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * 把 DSH_HOME 指到一次性临时目录，测试结束（含失败路径）恢复原值并清掉目录。
 *
 * src/plugin.js 的 apply() 会向 resolveHome() 落盘，测试不隔离就会写进真实
 * ~/.dsh。t.after 在断言抛错时同样执行，环境变量不会漏恢复。
 *
 * @param {object} t - node:test 的 TestContext。
 * @returns {string} 临时 DSH_HOME 目录。
 */
export function isolateHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bkl-home-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return dir
}
