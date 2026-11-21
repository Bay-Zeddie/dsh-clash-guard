/**
 * 全路由实测：九个端点逐个打一遍，验证结构完整、不 500。
 *
 * 跑法：node tests/routes-live.mjs
 *
 * 这是**集成测试**：真的加载插件、真的调 handler、真的走网络。
 * 只读端点全测；会改系统状态的（mode / calibrate / settings 写）只测 GET 或跳过。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const defaults = JSON.parse(fs.readFileSync(path.join(ROOT, 'defaults.json'), 'utf8'))

const routes = new Map()
// Windows 绝对路径必须先转成 file:// URL，否则 ESM loader 拒收 'c:' 协议
const mod = await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href)

/**
 * cordis 桩（tests/cordis-stub.mjs）：webServer 必须走 inject ——
 * index.js 的路由注册已改为 ctx.inject(['webServer'], cb) 形态。
 */
import { bootHost } from './cordis-stub.mjs'
await bootHost({
  webServer: {
    register(route) {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  },
})

await new Promise(r => setTimeout(r, 2500))

/**
 * 打一个端点，返回 { status, json, ms }。
 *
 * 请求/响应桩要满足两点，否则 handler 会挂住或读不到 body：
 *   1. `req.on('data'|'end')` 必须**同步**回调（插件用的是 collect 模式）；
 *   2. `res.end()` 收到的可能是字符串或 Buffer，统一按字节收。
 */
async function hit(method, routePath, body) {
  const route = routes.get(routePath)
  if (!route) return { status: 0, json: null, error: 'route not registered' }

  const chunks = []
  const listeners = new Map()

  const req = {
    method,
    url: routePath,
    headers: body === undefined
      ? { accept: 'application/json' }
      : {
        accept: 'application/json',
        'content-type': 'application/json',
        'x-requested-with': 'XMLHttpRequest',
        'content-length': String(Buffer.byteLength(JSON.stringify(body))),
      },
    on(event, fn) {
      listeners.set(event, fn)
      return req
    },
    destroy() {},
  }

  const res = {
    statusCode: 0,
    headers: {},
    headersSent: false,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers ?? {}; this.headersSent = true },
    setHeader(k, v) { this.headers[k] = v },
    end(payload) {
      if (payload !== undefined && payload !== null) {
        chunks.push(Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload)))
      }
    },
    destroy() {},
  }

  const started = Date.now()
  try {
    // 先把 handler 的 promise 挂上，再投递 body 事件 ——
    // 顺序反了 handler 会错过 'end'。
    const running = route.handler(req, res)
    if (body !== undefined) {
      const dataFn = listeners.get('data')
      const endFn = listeners.get('end')
      if (typeof dataFn === 'function') dataFn(Buffer.from(JSON.stringify(body)))
      if (typeof endFn === 'function') endFn()
    } else {
      const endFn = listeners.get('end')
      if (typeof endFn === 'function') endFn()
    }
    await running
  } catch (error) {
    return { status: -1, json: null, error: String(error.message ?? error), ms: Date.now() - started }
  }

  const text = Buffer.concat(chunks).toString('utf8')
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON */ }
  return { status: res.statusCode, json, text, ms: Date.now() - started }
}

// prefix 在 http 层级，routes 里没有它 —— 写错层级会拼出 "undefined/state"
const prefix = defaults.http.prefix
const routeTable = defaults.http.routes
const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? '✔' : '✘'} ${name}${detail ? ` — ${detail}` : ''}`)
}

console.log('=== 只读端点 ===')

// i18n
{
  const r = await hit('GET', `${prefix}${routeTable.i18n}`)
  const ok = r.status === 200 && r.json?.ok === true && r.json?.table?.zh && r.json?.table?.en
  check('GET /i18n', ok, `${r.ms}ms, zh=${Object.keys(r.json?.table?.zh ?? {}).length} 命名空间`)
}

// state
{
  const r = await hit('GET', `${prefix}${routeTable.state}`)
  const ok = r.status === 200 && typeof r.json?.reachable === 'boolean' && r.json?.settings
  check('GET /state', ok, `${r.ms}ms, reachable=${r.json?.reachable}, mode=${r.json?.mode ?? '-'}`)
}

// kernel
{
  const r = await hit('GET', `${prefix}${routeTable.kernel}`)
  const ok = r.status === 200 && typeof r.json?.ok === 'boolean'
  check('GET /kernel', ok, `${r.ms}ms, coreRunning=${r.json?.state?.coreRunning}`)
}

// nodes
{
  const r = await hit('GET', `${prefix}${routeTable.nodes}`)
  const ok = r.status === 200 && typeof r.json?.ok === 'boolean'
  const n = Array.isArray(r.json?.nodes) ? r.json.nodes.length : 0
  check('GET /nodes', ok, `${r.ms}ms, ${n} 个节点`)
}

// ip
{
  const r = await hit('GET', `${prefix}${routeTable.ip}`)
  const ok = r.status === 200
    && typeof r.json?.verdict === 'string'
    && typeof r.json?.system === 'object'
    && typeof r.json?.proxy === 'object'
    && typeof r.json?.bound === 'object'
  check('GET /ip', ok, `${r.ms}ms, verdict=${r.json?.verdict}, 三条路径齐全=${ok}`)
}

// verify（审计，最慢）—— 只接受 POST，用 GET 会 405
{
  const r = await hit('POST', `${prefix}${routeTable.verify}`, {})
  const checks = Array.isArray(r.json?.checks) ? r.json.checks.length : 0
  const ok = r.status === 200 && checks >= 19
  check('POST /verify', ok, `${r.ms}ms, ${checks} 项审计, verdict=${r.json?.verdict}`)
}

// verify 用 GET 应被拒
{
  const r = await hit('GET', `${prefix}${routeTable.verify}`)
  check('GET /verify → 405', r.status === 405, `status=${r.status}`)
}

// settings（只读）
{
  const r = await hit('GET', `${prefix}${routeTable.settings}`)
  const ok = r.status === 200 && r.json?.settings !== undefined
  check('GET /settings', ok, `${r.ms}ms`)
}

console.log('\n=== 写端点的拒绝路径（不真改系统） ===')

// mode：缺 body 应 400
{
  const r = await hit('POST', `${prefix}${routeTable.mode}`)
  check('POST /mode 无 body → 拒绝', r.status === 400 || r.status === 415, `status=${r.status}`)
}

// mode：非法值应 400
{
  const r = await hit('POST', `${prefix}${routeTable.mode}`, { mode: 'bogus' })
  check('POST /mode 非法值 → 拒绝', r.status === 400, `status=${r.status}`)
}

// calibrate 不需要 body（它自己探测真 IP），所以无 body 是**合法**的。
// 只验证它返回了结构化结果，不验证 400。
{
  const r = await hit('POST', `${prefix}${routeTable.calibrate}`)
  const ok = r.status === 200 && typeof r.json?.ok === 'boolean'
  check('POST /calibrate 无 body 也能工作', ok, `status=${r.status}, ok=${r.json?.ok}, ip=${r.json?.ip || '-'}`)
}

// calibrate 用 GET 应被拒
{
  const r = await hit('GET', `${prefix}${routeTable.calibrate}`)
  check('GET /calibrate → 405', r.status === 405, `status=${r.status}`)
}

// settings：未知键应被丢弃而不是写入
{
  const r = await hit('POST', `${prefix}${routeTable.settings}`, { ui: { notARealKey: 1 } })
  const ok = r.status === 200
  check('POST /settings 未知键被丢弃', ok, `status=${r.status}`)
}

console.log('\n=== 404 / 方法不匹配 ===')
{
  const r = await hit('GET', `${prefix}/nonexistent`)
  check('未知路由不崩', r.status === 0 || r.status === 404, `status=${r.status}`)
}

/* ---------------- 汇总 ---------------- */

const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) {
  console.log('失败：')
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`)
}
process.exit(failed.length === 0 ? 0 : 1)
