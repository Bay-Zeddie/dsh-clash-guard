/**
 * 双档监控架构测试。
 *
 * 保证三件事：
 *   1. **不假绿**：慢档发现的隐蔽泄漏（DNS 泄漏等）必须被快档继承
 *   2. **不重复**：快慢档命中同一因素时不重复列出
 *   3. **够快**：/ip 读快照 → 毫秒级响应（原来 5-10 秒）
 *
 * 跑法：node tests/monitor-verify.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const defaults = JSON.parse(fs.readFileSync(path.join(ROOT, 'defaults.json'), 'utf8'))

const tests = []
const test = (name, fn) => tests.push({ name, fn })

/* ---------------- monitor 模块（纯逻辑，无 IO） ---------------- */

const { createMonitor } = await import(pathToFileURL(path.join(ROOT, 'lib', 'monitor.js')).href)

test('monitor：read() 在没有快照时返回 ready=false', () => {
  const m = createMonitor({ configOf: () => defaults, paths: {}, probe: async () => ({ v: 1 }) })
  const snap = m.read()
  assert.equal(snap.ready, false)
  m.stop()
})

test('monitor：read() 立即返回，不等待正在进行的探测', async () => {
  let release
  const gate = new Promise(r => { release = r })
  const m = createMonitor({
    configOf: () => defaults,
    paths: {},
    probe: async () => { await gate; return { verdict: 'safe' } },
    fastProbe: async () => { await gate; return { verdict: 'safe' } },
  })
  m.start()
  await new Promise(r => setTimeout(r, 20))
  const t0 = Date.now()
  const snap = m.read()
  const elapsed = Date.now() - t0
  assert.equal(elapsed < 50, true, `read() 应立即返回，实际 ${elapsed}ms`)
  assert.equal(snap.ready, false, '探测未完成时快照未建立')
  release()
  m.stop()
})

test('monitor：探测完成后快照可读且带 age', async () => {
  const m = createMonitor({
    configOf: () => defaults,
    paths: {},
    probe: async () => ({ verdict: 'safe', factors: [] }),
    fastProbe: async () => ({ verdict: 'safe', factors: [] }),
  })
  await m.refresh()
  const snap = m.read()
  assert.equal(snap.ready, true)
  assert.equal(snap.verdict, 'safe')
  assert.equal(typeof snap.age, 'number')
  assert.equal(snap.age < 1000, true, 'age 应很小')
  m.stop()
})

test('monitor：探测失败时保留上一份快照（不变成空白）', async () => {
  let fail = false
  const m = createMonitor({
    configOf: () => defaults,
    paths: {},
    probe: async () => {
      if (fail) throw new Error('boom')
      return { verdict: 'leaking', factors: [] }
    },
    fastProbe: async () => {
      if (fail) throw new Error('boom')
      return { verdict: 'leaking', factors: [] }
    },
  })
  await m.refresh()
  fail = true
  await m.refresh()
  const snap = m.read()
  assert.equal(snap.ready, true, '失败后快照仍应可读')
  assert.equal(snap.verdict, 'leaking', '应保留上一份结论')
  assert.equal(snap.stale, true, '应标记为可能过期')
  m.stop()
})

test('monitor：慢档不阻塞快档（并行双档）', async () => {
  let slowDone = false
  let fastRan = false
  const m = createMonitor({
    configOf: () => defaults,
    paths: {},
    probe: async () => { await new Promise(r => setTimeout(r, 300)); slowDone = true; return { verdict: 'slow' } },
    fastProbe: async () => { fastRan = true; return { verdict: 'fast' } },
  })
  // 直接跑两次：慢档挂着时快档仍能跑
  const slowPromise = m._state.slowRunning === false ? null : null
  m.start()
  await new Promise(r => setTimeout(r, 60))
  assert.equal(fastRan, true, '慢档进行中时快档仍应运行')
  assert.equal(slowDone, false, '慢档还在跑')
  m.stop()
})

test('monitor：refresh() 跑慢档拿全量结论', async () => {
  let tier = null
  const m = createMonitor({
    configOf: () => defaults,
    paths: {},
    probe: async () => { tier = 'slow'; return { verdict: 'safe' } },
    fastProbe: async () => { tier = 'fast'; return { verdict: 'safe' } },
  })
  await m.refresh()
  assert.equal(tier, 'slow', '手动刷新应跑慢档')
  m.stop()
})

/* ---------------- probe 模块：假绿防护 ---------------- */

const { createProbe } = await import(pathToFileURL(path.join(ROOT, 'lib', 'probe.js')).href)
const guard = await import(pathToFileURL(path.join(ROOT, 'lib', 'guard.js')).href)
const { stateFile } = await import(pathToFileURL(path.join(ROOT, 'lib', 'paths.js')).href)

test('probe：慢档发现的 critical 因素被快档继承（杜绝假绿）', async () => {
  const p = createProbe({
    configOf: () => defaults,
    paths: { stateFile: stateFile() },
    guard,
  })
  // 真实探测：慢档会发现 DNS 泄漏等隐蔽因素
  const slow = await p.probe()
  const fast = await p.probeFast()

  const slowIds = slow.factors.filter(f => f.level === 'critical').map(f => f.id)
  const fastIds = fast.factors.filter(f => f.level === 'critical').map(f => f.id)
  for (const id of slowIds) {
    assert.ok(fastIds.includes(id), `快档必须继承慢档的 ${id}（否则会假绿）`)
  }
  assert.equal(fast.verdict, slow.verdict, '快慢档结论必须一致')
})

test('probe：快慢档因素无重复', async () => {
  const p = createProbe({
    configOf: () => defaults,
    paths: { stateFile: stateFile() },
    guard,
  })
  await p.probe()
  const fast = await p.probeFast()
  const ids = fast.factors.map(f => f.id)
  assert.equal(new Set(ids).size, ids.length, `因素重复：${ids.join(',')}`)
})

test('probe：因素按严重度排序（critical 在前）', async () => {
  const p = createProbe({
    configOf: () => defaults,
    paths: { stateFile: stateFile() },
    guard,
  })
  await p.probe()
  const fast = await p.probeFast()
  const rank = { critical: 0, high: 1, warn: 2 }
  const levels = fast.factors.map(f => f.level)
  for (let i = 1; i < levels.length; i++) {
    assert.ok(
      (rank[levels[i]] ?? 9) >= (rank[levels[i - 1]] ?? 9),
      `因素未按严重度排序：${levels.join(',')}`,
    )
  }
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
