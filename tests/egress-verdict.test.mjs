/**
 * 整机出口判定测试。
 *
 * 核心区别（这次修改的原因）：
 *   · 旧行为：只问代理端口 → 回答「代理能不能出去」
 *   · 新行为：系统 / 代理 / 绑卡 三条路径 → 回答「这台电脑在用什么 IP 出去」
 *
 * 本测试用桩驱动 `/ip` 的判定分支，不碰真实网络。
 *
 * 跑法：node tests/egress-verdict.test.mjs
 */
import assert from 'node:assert/strict'

/**
 * 复刻 /ip 的判定逻辑（与 lib/http.js 保持一致）。
 * 单独抽出来测，因为它是最容易写错、后果又最严重的一段。
 */
function decide({ realIp, system, proxy, bound }) {
  const exposedPaths = []
  if (realIp !== '') {
    if (system.ok && system.ip === realIp) exposedPaths.push('system')
    if (bound.ok && bound.ip === realIp) exposedPaths.push('bound')
    if (proxy.ok && proxy.ip === realIp) exposedPaths.push('proxy')
  }

  let verdict
  let tone
  if (realIp === '') {
    verdict = 'uncalibrated'
    tone = 'warn'
  } else if (exposedPaths.length > 0) {
    verdict = 'exposed'
    tone = 'off'
  } else if (bound.ok) {
    verdict = 'bypassable'
    tone = 'warn'
  } else if (proxy.ok) {
    verdict = 'masked'
    tone = 'on'
  } else {
    verdict = 'no-egress'
    tone = 'warn'
  }
  return { verdict, tone, exposedPaths }
}

const REAL = '39.144.124.132'
const NODE = '103.187.168.155'
const OTHER = '18.183.108.154'

const cases = [
  {
    name: '系统出口 = 真 IP → exposed（TUN 没接管，整机在裸奔）',
    input: { realIp: REAL, system: { ok: true, ip: REAL }, proxy: { ok: true, ip: NODE }, bound: { ok: false, ip: '' } },
    verdict: 'exposed',
    tone: 'off',
    paths: ['system'],
  },
  {
    name: '绑卡出口 = 真 IP → exposed（绑网卡的程序在漏）',
    input: { realIp: REAL, system: { ok: true, ip: NODE }, proxy: { ok: true, ip: NODE }, bound: { ok: true, ip: REAL } },
    verdict: 'exposed',
    tone: 'off',
    paths: ['bound'],
  },
  {
    name: '三条都是真 IP → exposed，三条都点名',
    input: { realIp: REAL, system: { ok: true, ip: REAL }, proxy: { ok: true, ip: REAL }, bound: { ok: true, ip: REAL } },
    verdict: 'exposed',
    tone: 'off',
    paths: ['system', 'bound', 'proxy'],
  },
  {
    name: '绑卡能出网但不是真 IP → bypassable（黄，这条路是活的）',
    input: { realIp: REAL, system: { ok: true, ip: NODE }, proxy: { ok: true, ip: NODE }, bound: { ok: true, ip: OTHER } },
    verdict: 'bypassable',
    tone: 'warn',
    paths: [],
  },
  {
    name: '绑卡被堵 + 代理出口正常 → masked（绿，理想状态）',
    input: { realIp: REAL, system: { ok: true, ip: NODE }, proxy: { ok: true, ip: NODE }, bound: { ok: false, ip: '' } },
    verdict: 'masked',
    tone: 'on',
    paths: [],
  },
  {
    name: '未校准 → uncalibrated（黄，不猜）',
    input: { realIp: '', system: { ok: true, ip: NODE }, proxy: { ok: true, ip: NODE }, bound: { ok: false, ip: '' } },
    verdict: 'uncalibrated',
    tone: 'warn',
    paths: [],
  },
  {
    name: '全部不通 → no-egress',
    input: { realIp: REAL, system: { ok: false, ip: '' }, proxy: { ok: false, ip: '' }, bound: { ok: false, ip: '' } },
    verdict: 'no-egress',
    tone: 'warn',
    paths: [],
  },
  {
    name: '控制器挂了但系统出口可用 → no-egress（代理测不了，如实说）',
    input: { realIp: REAL, system: { ok: true, ip: NODE }, proxy: { ok: false, ip: '' }, bound: { ok: false, ip: '' } },
    verdict: 'no-egress',
    tone: 'warn',
    paths: [],
  },
]

let failed = 0
console.log('=== 判定分支 ===')
for (const item of cases) {
  try {
    const got = decide(item.input)
    assert.equal(got.verdict, item.verdict, `verdict 应为 ${item.verdict}，实际 ${got.verdict}`)
    assert.equal(got.tone, item.tone, `tone 应为 ${item.tone}，实际 ${got.tone}`)
    assert.deepEqual(got.exposedPaths, item.paths, `暴露路径应为 ${item.paths.join('+') || '(无)'}，实际 ${got.exposedPaths.join('+') || '(无)'}`)
    console.log(`  ✔ ${item.name}`)
  } catch (error) {
    failed += 1
    console.log(`  ✘ ${item.name}`)
    console.log(`      ${error.message}`)
  }
}

/* ---------------- 优先级：暴露必须先于其他结论 ---------------- */

console.log('\n=== 优先级 ===')
const priority = [
  ['未校准优先于一切（无真 IP 就没法判）', { realIp: '', system: { ok: true, ip: REAL }, proxy: { ok: true, ip: NODE }, bound: { ok: true, ip: REAL } }, 'uncalibrated'],
  ['暴露优先于可绕过', { realIp: REAL, system: { ok: true, ip: REAL }, proxy: { ok: true, ip: NODE }, bound: { ok: true, ip: OTHER } }, 'exposed'],
  ['可绕过优先于已隐藏', { realIp: REAL, system: { ok: true, ip: NODE }, proxy: { ok: true, ip: NODE }, bound: { ok: true, ip: OTHER } }, 'bypassable'],
]
for (const [label, input, expected] of priority) {
  try {
    const got = decide(input)
    assert.equal(got.verdict, expected, `应为 ${expected}，实际 ${got.verdict}`)
    console.log(`  ✔ ${label}`)
  } catch (error) {
    failed += 1
    console.log(`  ✘ ${label}`)
    console.log(`      ${error.message}`)
  }
}

console.log(`\n${cases.length + priority.length - failed}/${cases.length + priority.length} 通过`)
process.exit(failed === 0 ? 0 : 1)
