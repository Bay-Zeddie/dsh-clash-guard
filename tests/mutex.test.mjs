/**
 * 互斥队列测试：并发 switchMode 必须串行执行。
 *
 * 用桩验证队列语义，不打真内核。
 *
 * 跑法：node tests/mutex.test.mjs
 */
import assert from 'node:assert/strict'

/**
 * 复刻 guard.js 里的互斥实现（同一份代码逻辑，独立验证其性质）。
 * 若 guard.js 的实现变了，这里的复刻也要同步 —— 测试的价值在于
 * 证明「这个模式是正确的」。
 */
let queue = Promise.resolve()
function enqueue(task) {
  // 与 guard.js 的实现保持一致：箭头包一层，让返回值穿透
  const run = queue.then(() => task(), () => task())
  queue = run.then(() => undefined, () => undefined)
  return run
}

const tests = []
const test = (name, fn) => tests.push({ name, fn })

test('并发调用严格串行（无重叠）', async () => {
  let running = 0
  let maxConcurrent = 0
  const order = []

  const task = async (id) => {
    running++
    maxConcurrent = Math.max(maxConcurrent, running)
    await new Promise(r => setTimeout(r, 30))
    order.push(id)
    running--
    return id
  }

  // 同时发起 5 个
  const results = await Promise.all([1, 2, 3, 4, 5].map(id => enqueue(() => task(id))))
  assert.deepEqual(results, [1, 2, 3, 4, 5], '每个调用应拿到自己任务的返回值')
  assert.equal(maxConcurrent, 1, `最大并发应为 1，实际 ${maxConcurrent}`)
  assert.deepEqual(order, [1, 2, 3, 4, 5], '执行顺序应与发起顺序一致（FIFO）')
})

test('某次失败不卡死后续排队者', async () => {
  const order = []
  const results = await Promise.allSettled([
    enqueue(async () => { order.push('a'); throw new Error('boom') }),
    enqueue(async () => { order.push('b'); return 'b-ok' }),
    enqueue(async () => { order.push('c'); return 'c-ok' }),
  ])
  assert.deepEqual(order, ['a', 'b', 'c'], '失败者之后的任务仍应执行')
  assert.equal(results[0].status, 'rejected', '第一个应失败')
  assert.equal(results[1].status, 'fulfilled')
  assert.equal(results[1].value, 'b-ok')
  assert.equal(results[2].status, 'fulfilled')
  assert.equal(results[2].value, 'c-ok')
})

test('失败会正确传播给调用方（但不毒化队列）', async () => {
  await assert.rejects(
    () => enqueue(async () => { throw new Error('expected') }),
    /expected/,
    '调用方应收到错误',
  )
  // 队列还活着
  const ok = await enqueue(async () => 'still-alive')
  assert.equal(ok, 'still-alive', '失败后队列仍能处理后续任务')
})

test('乱序完成时长任务不插队', async () => {
  // 短任务在长任务之后发起，但必须排在后面
  const order = []
  await Promise.all([
    enqueue(async () => { await new Promise(r => setTimeout(r, 80)); order.push('long') }),
    enqueue(async () => { order.push('short') }),
  ])
  assert.deepEqual(order, ['long', 'short'], '后发起的短任务必须等长任务完成')
})

/* ---------------- 跑 ---------------- */

let failed = 0
for (const { name, fn } of tests) {
  try {
    await fn()
    console.log(`  ✔ ${name}`)
  } catch (error) {
    failed++
    console.log(`  ✘ ${name}`)
    console.log(`      ${error.message}`)
  }
}
console.log(`\n${tests.length - failed}/${tests.length} 通过`)
process.exit(failed === 0 ? 0 : 1)
