/**
 * 配置装配的差异写入测试。
 *
 * 验证 `saveConfig` 只落「与 defaults 不同的键」——
 * 这决定了 defaults 升级能否生效、用户文件是否可读。
 *
 * 跑法：node tests/settings.test.mjs
 */
import assert from 'node:assert/strict'
import { mergeShaped, diffAgainst } from '../lib/settings.js'
import { readDefaults } from '../lib/paths.js'

const defaults = readDefaults()
const tests = []
const test = (name, fn) => tests.push({ name, fn })

test('无改动时差异为空', () => {
  const merged = mergeShaped(defaults, {})
  assert.equal(diffAgainst(defaults, merged), undefined, '全默认值不应产生差异')
})

test('改一个叶子只落那一个', () => {
  const merged = mergeShaped(defaults, { ui: { indicatorPollMs: 60000 } })
  const diff = diffAgainst(defaults, merged)
  assert.deepEqual(diff, { ui: { indicatorPollMs: 60000 } }, `实际：${JSON.stringify(diff)}`)
})

test('改多个不同分支都保留', () => {
  const merged = mergeShaped(defaults, {
    ui: { indicatorPollMs: 60000, enablePill: true },
    egress: { timeoutMs: 5000 },
  })
  const diff = diffAgainst(defaults, merged)
  assert.deepEqual(diff, {
    ui: { indicatorPollMs: 60000, enablePill: true },
    egress: { timeoutMs: 5000 },
  })
})

test('数组整体替换', () => {
  const next = ['https://a.test', 'https://b.test']
  const merged = mergeShaped(defaults, { egress: { endpoints: next } })
  const diff = diffAgainst(defaults, merged)
  assert.deepEqual(diff, { egress: { endpoints: next } })
})

test('数组相同则不落', () => {
  const merged = mergeShaped(defaults, { egress: { endpoints: defaults.egress.endpoints } })
  const diff = diffAgainst(defaults, merged)
  assert.equal(diff, undefined)
})

test('注释键（_ 开头）不落用户文件', () => {
  const merged = mergeShaped(defaults, { ui: { indicatorPollMs: 60000 } })
  const diff = diffAgainst(defaults, merged)
  const text = JSON.stringify(diff)
  assert.ok(!text.includes('"_'), `注释键泄漏进差异：${text}`)
})

test('差异能还原出等价配置', () => {
  const patch = { ui: { indicatorPollMs: 9000 }, harden: { strictRoute: false } }
  const merged = mergeShaped(defaults, patch)
  const diff = diffAgainst(defaults, merged)
  // 用差异重新 merge 一次，应得到同样的结果
  const roundTrip = mergeShaped(defaults, diff)
  assert.deepEqual(roundTrip, merged, '差异往返后配置不一致')
})

test('类型不符的覆盖被丢弃', () => {
  const merged = mergeShaped(defaults, { ui: { indicatorPollMs: 'not-a-number' } })
  assert.equal(merged.ui.indicatorPollMs, defaults.ui.indicatorPollMs, '字符串不应覆盖数字')
})

test('未知键被丢弃', () => {
  const merged = mergeShaped(defaults, { ui: { notARealKey: 1 } })
  assert.ok(!Object.hasOwn(merged.ui, 'notARealKey'), '未知键不应进入配置')
})

test('panelSlot 在 defaults 里存在且非空', () => {
  assert.equal(typeof defaults.ui.panelSlot, 'string')
  assert.ok(defaults.ui.panelSlot.length > 0, 'ui.panelSlot 必须非空（零硬编码要求）')
})

/* ---------------- 跑 ---------------- */

let failed = 0
for (const { name, fn } of tests) {
  try {
    fn()
    console.log(`  ✔ ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  ✘ ${name}`)
    console.log(`      ${error.message}`)
  }
}
console.log(`\n${tests.length - failed}/${tests.length} 通过`)
process.exit(failed === 0 ? 0 : 1)
