/**
 * 泄漏因素聚合判定测试。
 *
 * 这是指示灯「报红」逻辑的核心：任一 critical 因素命中就必须红。
 * 真机踩过的教训：出口 IP 在越南、运营商换了、国家也换了，看起来完美，
 * 但 DNS 出口还在 China Mobile —— 那种状态原来显示绿色「已隐藏」。
 *
 * 跑法：node tests/leak-factors.test.mjs
 */
import assert from 'node:assert/strict'
import { collectLeakFactors, verdictFromFactors, LEAK_FACTORS } from '../lib/leak-factors.js'

const tests = []
const test = (name, fn) => tests.push({ name, fn })

/* ---------------- 因素清单 ---------------- */

test('因素清单完整：5 critical + 2 high + 1 warn', () => {
  assert.equal(LEAK_FACTORS.length, 8)
  assert.equal(LEAK_FACTORS.filter(f => f.level === 'critical').length, 5)
  assert.equal(LEAK_FACTORS.filter(f => f.level === 'high').length, 2)
  assert.equal(LEAK_FACTORS.filter(f => f.level === 'warn').length, 1)
})

test('每个因素都有 id / level / title', () => {
  for (const f of LEAK_FACTORS) {
    assert.ok(typeof f.id === 'string' && f.id !== '', `因素缺 id`)
    assert.ok(['critical', 'high', 'warn'].includes(f.level), `${f.id} 的 level 非法`)
    assert.ok(typeof f.title === 'string' && f.title !== '', `${f.id} 缺 title`)
  }
})

/* ---------------- 单因素命中 ---------------- */

test('DNS 泄漏 → critical 命中，判定 leaking（真机实测场景）', () => {
  const factors = collectLeakFactors({
    exposedPaths: [],
    dnsLeak: { leaked: true, detail: 'DNS 出口在 China Mobile（AS9808）' },
    interfaceBypass: { bypassable: false },
    machineTraffic: { processes: [] },
    tunEnabled: true,
    strictRoute: true,
    fakeIpActive: true,
    systemResolver: { leaked: false },
  })
  assert.equal(factors.length, 1)
  assert.equal(factors[0].id, 'dns-leak')
  assert.equal(factors[0].level, 'critical')

  const decision = verdictFromFactors(factors, { calibrated: true, egressOk: true })
  assert.equal(decision.verdict, 'leaking')
  assert.equal(decision.tone, 'off', 'leaking 必须是红')
})

test('出口 IP 等于真 IP → critical，判定 leaking', () => {
  const factors = collectLeakFactors({
    exposedPaths: ['system', 'bound'],
    dnsLeak: { leaked: false },
    interfaceBypass: { bypassable: false },
    machineTraffic: { processes: [] },
    tunEnabled: true,
    strictRoute: true,
    fakeIpActive: true,
    systemResolver: { leaked: false },
  })
  assert.equal(factors.length, 1)
  assert.equal(factors[0].id, 'egress-equals-real')
  assert.equal(verdictFromFactors(factors, { calibrated: true, egressOk: true }).verdict, 'leaking')
})

test('绑卡可绕过 → critical，判定 leaking', () => {
  const factors = collectLeakFactors({
    exposedPaths: [],
    dnsLeak: { leaked: false },
    interfaceBypass: { bypassable: true, detail: '绑定 10.252.28.236 能连到 1.1.1.1:80' },
    machineTraffic: { processes: [] },
    tunEnabled: true,
    strictRoute: true,
    fakeIpActive: true,
    systemResolver: { leaked: false },
  })
  assert.equal(factors.length, 1)
  assert.equal(factors[0].id, 'interface-bypass')
  assert.equal(verdictFromFactors(factors, { calibrated: true, egressOk: true }).verdict, 'leaking')
})

test('有进程直连 → critical，判定 leaking', () => {
  const factors = collectLeakFactors({
    exposedPaths: [],
    dnsLeak: { leaked: false },
    interfaceBypass: { bypassable: false },
    machineTraffic: { processes: [{ name: 'GameViewerServer', count: 3 }, { name: 'wpscloudsvr', count: 1 }] },
    tunEnabled: true,
    strictRoute: true,
    fakeIpActive: true,
    systemResolver: { leaked: false },
  })
  assert.equal(factors.length, 1)
  assert.equal(factors[0].id, 'machine-traffic')
  assert.ok(factors[0].detail.includes('GameViewerServer'), 'detail 应点名进程')
  assert.equal(verdictFromFactors(factors, { calibrated: true, egressOk: true }).verdict, 'leaking')
})

test('TUN 关闭 → critical，判定 leaking', () => {
  const factors = collectLeakFactors({
    exposedPaths: [],
    dnsLeak: { leaked: false },
    interfaceBypass: { bypassable: false },
    machineTraffic: { processes: [] },
    tunEnabled: false,
    strictRoute: true,
    fakeIpActive: true,
    systemResolver: { leaked: false },
  })
  assert.equal(factors.length, 1)
  assert.equal(factors[0].id, 'tun-off')
  assert.equal(verdictFromFactors(factors, { calibrated: true, egressOk: true }).verdict, 'leaking')
})

test('系统解析未走 fake-ip → high，判定 risky（红）', () => {
  const factors = collectLeakFactors({
    exposedPaths: [],
    dnsLeak: { leaked: false },
    interfaceBypass: { bypassable: false },
    machineTraffic: { processes: [] },
    tunEnabled: true,
    strictRoute: true,
    fakeIpActive: true,
    systemResolver: { leaked: true, detail: '系统解析得到真实地址 223.106.89.226' },
  })
  assert.equal(factors.length, 1)
  assert.equal(factors[0].level, 'high')
  const decision = verdictFromFactors(factors, { calibrated: true, egressOk: true })
  assert.equal(decision.verdict, 'risky')
  assert.equal(decision.tone, 'off', 'high 也必须是红')
})

test('fake-ip 未生效 → warn，判定 weak（黄）', () => {
  const factors = collectLeakFactors({
    exposedPaths: [],
    dnsLeak: { leaked: false },
    interfaceBypass: { bypassable: false },
    machineTraffic: { processes: [] },
    tunEnabled: true,
    strictRoute: true,
    fakeIpActive: false,
    systemResolver: { leaked: false },
  })
  assert.equal(factors.length, 1)
  assert.equal(factors[0].level, 'warn')
  const decision = verdictFromFactors(factors, { calibrated: true, egressOk: true })
  assert.equal(decision.verdict, 'weak')
  assert.equal(decision.tone, 'warn')
})

/* ---------------- 组合与边界 ---------------- */

test('完美状态 → 零因素，判定 safe（绿）', () => {
  const factors = collectLeakFactors({
    exposedPaths: [],
    dnsLeak: { leaked: false },
    interfaceBypass: { bypassable: false },
    machineTraffic: { processes: [] },
    tunEnabled: true,
    strictRoute: true,
    fakeIpActive: true,
    systemResolver: { leaked: false },
  })
  assert.equal(factors.length, 0)
  const decision = verdictFromFactors(factors, { calibrated: true, egressOk: true })
  assert.equal(decision.verdict, 'safe')
  assert.equal(decision.tone, 'on', 'safe 必须是绿')
})

test('多因素同时命中：critical 优先于 high/warn', () => {
  const factors = collectLeakFactors({
    exposedPaths: ['system'],
    dnsLeak: { leaked: true, detail: 'DNS 泄漏' },
    interfaceBypass: { bypassable: true },
    machineTraffic: { processes: [{ name: 'x', count: 1 }] },
    tunEnabled: false,
    strictRoute: false,
    fakeIpActive: false,
    systemResolver: { leaked: true },
  })
  // 5 critical + 2 high + 1 warn = 8 全中
  assert.equal(factors.length, 8)
  const decision = verdictFromFactors(factors, { calibrated: true, egressOk: true })
  assert.equal(decision.verdict, 'leaking')
  assert.equal(decision.tone, 'off')
  assert.ok(decision.reason.length > 0, 'reason 应列出命中的因素')
})

test('未校准 → uncalibrated（空心中点），不误报安全', () => {
  const decision = verdictFromFactors([], { calibrated: false })
  assert.equal(decision.verdict, 'uncalibrated')
  assert.equal(decision.tone, 'unknown')
})

test('无出口 → no-egress（灰点），不是安全也不是风险', () => {
  const decision = verdictFromFactors([], { calibrated: true, egressOk: false })
  assert.equal(decision.verdict, 'no-egress')
  assert.equal(decision.tone, 'idle')
})

test('探针返回 null 时不误判（全部探针失败的降级场景）', () => {
  const factors = collectLeakFactors({
    exposedPaths: [],
    dnsLeak: null,
    interfaceBypass: null,
    machineTraffic: null,
    tunEnabled: null,
    strictRoute: null,
    fakeIpActive: null,
    systemResolver: null,
  })
  // null 不等于「没有泄漏」，但也不该凭空造出因素
  assert.equal(factors.length, 0)
  // 此时若已校准且有出口，会判 safe —— 这是已知的保守边界：
  // 探针全挂时宁可说安全也不能瞎报红，但 phase 会是 unreachable 提示用户
  const decision = verdictFromFactors(factors, { calibrated: true, egressOk: true })
  assert.equal(decision.verdict, 'safe')
})

test('dnsLeak.leaked 为 null（不确定）不算命中', () => {
  const factors = collectLeakFactors({
    exposedPaths: [],
    dnsLeak: { leaked: null, level: 'uncertain', detail: '无法判定' },
    interfaceBypass: { bypassable: false },
    machineTraffic: { processes: [] },
    tunEnabled: true,
    strictRoute: true,
    fakeIpActive: true,
    systemResolver: { leaked: false },
  })
  assert.equal(factors.length, 0, '不确定不该算成泄漏')
})

/* ---------------- 跑 ---------------- */

let failed = 0
for (const { name, fn } of tests) {
  try {
    await fn()
    console.log(`  ✔ ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  ✘ ${name}`)
    console.log(`      ${error.message}`)
  }
}
console.log(`\n${tests.length - failed}/${tests.length} 通过`)
process.exit(failed === 0 ? 0 : 1)
