// 配置校验：宿主用同一个 Standard Schema 在装载前校验行配置。
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { Config } from '../src/plugin.js'

const validate = Config['~standard'].validate

test('空配置补齐全套默认值，默认数组不共享', () => {
  for (const input of [undefined, null, {}]) {
    const result = validate(input)
    assert.deepEqual(result.value, {
      enabled: true,
      injectFile: '',
      hostRoot: '',
      allowedHosts: [],
      order: 8999,
    })
  }
  const first = validate({})
  first.value.allowedHosts.push('example.local')
  assert.deepEqual(validate({}).value.allowedHosts, [])
})

test('显式值覆盖默认值，未知键原样保留', () => {
  const result = validate({
    enabled: false,
    injectFile: 'C:/tmp/inject.md',
    hostRoot: 'D:/host',
    allowedHosts: ['nas.local:3081', '127.0.0.1'],
    order: 10300,
    experimentalFlag: true,
  })
  assert.deepEqual(result.value, {
    enabled: false,
    injectFile: 'C:/tmp/inject.md',
    hostRoot: 'D:/host',
    allowedHosts: ['nas.local:3081', '127.0.0.1'],
    order: 10300,
    experimentalFlag: true,
  })
})

test('已知键类型写错逐个报位置，非对象输入直接拒', () => {
  const result = validate({
    enabled: 'true',
    injectFile: 3,
    hostRoot: null,
    allowedHosts: ['ok', '', 7],
    order: '9000',
  })
  assert.equal(result.issues.length, 6)
  assert.deepEqual(result.issues.map(issue => issue.path.join('.')), [
    'enabled',
    'injectFile',
    'hostRoot',
    'allowedHosts.1',
    'allowedHosts.2',
    'order',
  ])
  assert.deepEqual(validate(42), { issues: [{ message: '插件配置必须是对象' }] })
  assert.deepEqual(validate([]), { issues: [{ message: '插件配置必须是对象' }] })
})

test('装配补丁里的行配置键与 schema 已知键一致', () => {
  const yaml = fs.readFileSync(new URL('../src/bundle.yml', import.meta.url), 'utf8')
  const row = yaml.slice(yaml.indexOf("name: 'rumo-dsh-breaklimit'"))
  const keys = [...row.matchAll(/^\s{8}([A-Za-z][\w]*):/gmu)].map(match => match[1]).sort()
  assert.deepEqual(keys, ['allowedHosts', 'enabled', 'hostRoot', 'injectFile', 'order'])
  assert.deepEqual(Object.keys(validate({}).value).sort(), keys)
})
