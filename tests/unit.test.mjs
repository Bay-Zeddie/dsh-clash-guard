/**
 * 单元测试：纯函数层（不碰网络、不碰系统）。
 *
 * 跑法：node --test tests/*.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { topScalar, barePipeName, pipeFromCommandLine, runtimeFromCommandLine, exeFromCommandLine } from '../lib/discover.js'
import { parseResponse } from '../lib/mihomo.js'
import { mergeShaped, applyEnv } from '../lib/settings.js'
import { looksLikeIp } from '../lib/egress.js'
import { coreModeOf, modeNameOf } from '../lib/guard.js'
import { readDefaults } from '../lib/paths.js'

const DEFAULTS = readDefaults()

test('topScalar 只认行首无缩进的键', () => {
  const yaml = [
    'mode: global',
    'mixed-port: 7897',
    'dns:',
    '  enable: true',
    "external-controller: ''",
    'secret: abc # trailing comment',
    '  mode: nested-not-this',
  ].join('\n')
  assert.equal(topScalar(yaml, 'mode'), 'global')
  assert.equal(topScalar(yaml, 'mixed-port'), '7897')
  assert.equal(topScalar(yaml, 'external-controller'), '')
  assert.equal(topScalar(yaml, 'secret'), 'abc')
  assert.equal(topScalar(yaml, 'missing'), '')
})

test('topScalar 去引号并忽略行内注释', () => {
  assert.equal(topScalar('secret: "quoted-value"', 'secret'), 'quoted-value')
  assert.equal(topScalar("secret: 'single'", 'secret'), 'single')
  assert.equal(topScalar('mixed-port: 7897 # port', 'mixed-port'), '7897')
})

test('barePipeName 规范化各种写法', () => {
  assert.equal(barePipeName('\\\\.\\pipe\\verge-mihomo-abc'), 'verge-mihomo-abc')
  assert.equal(barePipeName('\\\\.\\pipe\\mihomo-x'), 'mihomo-x')
  assert.equal(barePipeName('verge-mihomo-plain'), 'verge-mihomo-plain')
  assert.equal(barePipeName(''), '')
})

test('pipeFromCommandLine 从 -ext-ctl-pipe 抓名字', () => {
  const cmd = '"C:\\x\\verge-mihomo.exe" -d C:\\rt -f C:\\rt\\config.yaml -ext-ctl-pipe \\\\.\\pipe\\verge-mihomo-production-abc'
  assert.equal(pipeFromCommandLine(cmd), 'verge-mihomo-production-abc')
  assert.equal(pipeFromCommandLine('no pipe here'), '')
  assert.equal(pipeFromCommandLine(''), '')
})

test('runtimeFromCommandLine 从 -d 抓运行目录', () => {
  const cmd = 'x.exe -d "C:\\ProgramData\\svc\\users\\abc\\runtime" -f config.yaml'
  assert.equal(runtimeFromCommandLine(cmd), 'C:\\ProgramData\\svc\\users\\abc\\runtime')
  assert.equal(runtimeFromCommandLine('x.exe -d C:\\rt'), 'C:\\rt')
  assert.equal(runtimeFromCommandLine('x.exe'), '')
})

test('exeFromCommandLine 取 basename 小写', () => {
  assert.equal(exeFromCommandLine('"C:\\A\\Verge-Mihomo.exe" -d x'), 'verge-mihomo.exe')
  assert.equal(exeFromCommandLine('plain.exe'), 'plain.exe')
})

test('parseResponse 处理 Content-Length', () => {
  const raw = Buffer.from('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"a":1}', 'utf8')
  const out = parseResponse(raw)
  assert.equal(out.status, 200)
  assert.equal(out.text, '{"a":1}')
})

test('parseResponse 处理 chunked', () => {
  const body = '{"mode":"global"}'
  const raw = Buffer.from(
    `HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n${body.length.toString(16)}\r\n${body}\r\n0\r\n\r\n`,
    'utf8',
  )
  const out = parseResponse(raw)
  assert.equal(out.status, 200)
  assert.equal(out.text, body)
})

test('parseResponse 处理 204 空体', () => {
  const raw = Buffer.from('HTTP/1.1 204 No Content\r\n\r\n', 'utf8')
  const out = parseResponse(raw)
  assert.equal(out.status, 204)
  assert.equal(out.text, '')
})

test('mergeShaped 只接受模板里存在的键且类型一致', () => {
  const template = { a: 1, b: 'x', c: true, d: ['k'], e: { f: 2 } }
  const out = mergeShaped(template, { a: 9, b: 123, c: false, zzz: 'nope', e: { f: 5, g: 6 } })
  assert.equal(out.a, 9, '类型一致的数字被接受')
  assert.equal(out.b, 'x', '类型不符被丢弃')
  assert.equal(out.c, false)
  assert.equal(Object.hasOwn(out, 'zzz'), false, '未知键不进入结果')
  assert.equal(out.e.f, 5)
  assert.equal(Object.hasOwn(out.e, 'g'), false)
})

test('mergeShaped 数组整体替换而不是逐项合并', () => {
  const out = mergeShaped({ list: ['a', 'b'] }, { list: ['z'] })
  assert.deepEqual(out.list, ['z'])
})

test('applyEnv 按 __ 路径覆盖并做类型转换', () => {
  const config = { a: { b: 1, c: 'x', d: true, e: ['k'] } }
  const applied = applyEnv(config, {
    DSH_CLASH_GUARD_A__B: '42',
    DSH_CLASH_GUARD_A__C: 'hello',
    DSH_CLASH_GUARD_A__D: 'false',
    DSH_CLASH_GUARD_A__E: 'p,q',
    DSH_CLASH_GUARD_UNKNOWN: 'ignored',
    OTHER_VAR: 'ignored',
  })
  assert.equal(config.a.b, 42)
  assert.equal(config.a.c, 'hello')
  assert.equal(config.a.d, false)
  assert.deepEqual(config.a.e, ['p', 'q'])
  assert.equal(applied.length, 4)
})

test('looksLikeIp 识别 IPv4 / IPv6 / 拒绝垃圾', () => {
  assert.equal(looksLikeIp('1.2.3.4'), true)
  assert.equal(looksLikeIp('255.255.255.255'), true)
  assert.equal(looksLikeIp('256.1.1.1'), false)
  assert.equal(looksLikeIp('1.2.3'), false)
  assert.equal(looksLikeIp('2001:db8::1'), true)
  assert.equal(looksLikeIp('not-an-ip'), false)
  assert.equal(looksLikeIp(''), false)
})

test('modes 映射双向一致', () => {
  const modes = DEFAULTS.modes
  assert.equal(coreModeOf(modes, 'global'), 'global')
  assert.equal(coreModeOf(modes, 'rule'), 'rule')
  assert.equal(coreModeOf(modes, 'off'), 'direct')
  assert.equal(coreModeOf(modes, 'bogus'), '')
  assert.equal(modeNameOf(modes, 'global'), 'global')
  assert.equal(modeNameOf(modes, 'direct'), 'off')
  assert.equal(modeNameOf(modes, 'unknown-mode'), 'unknown-mode')
})

test('defaults 关键结构存在且非空', () => {
  assert.ok(Array.isArray(DEFAULTS.egress.endpoints) && DEFAULTS.egress.endpoints.length > 0)
  assert.ok(Array.isArray(DEFAULTS.discovery.pipePrefixes) && DEFAULTS.discovery.pipePrefixes.length > 0)
  assert.ok(Array.isArray(DEFAULTS.discovery.coreNames) && DEFAULTS.discovery.coreNames.length > 0)
  assert.ok(Array.isArray(DEFAULTS.discovery.tunAdapterPatterns))
  assert.ok(Array.isArray(DEFAULTS.discovery.virtualAdapterPatterns))
  assert.equal(typeof DEFAULTS.http.prefix, 'string')
  assert.ok(DEFAULTS.http.prefix.startsWith('/'))
  assert.equal(typeof DEFAULTS.tools.status, 'string')
  assert.ok(DEFAULTS.audit.blockingSeverities.length > 0)
  assert.equal(DEFAULTS.bypass.selectorGroup, 'GLOBAL')
})
