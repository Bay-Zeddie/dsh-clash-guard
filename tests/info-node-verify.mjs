/**
 * 信息节点拒切验证（事件时序修正版）。
 *
 * 教训：handler 第一行就可能 await（targetOf 等），同步投递 body 事件
 * 会在 listener 注册前丢失。真实网络里事件是异步到达的，所以测试桩
 * 也必须异步投递 —— 用 setTimeout(0) 把投递推到下一个宏任务。
 *
 * 跑法：node tests/info-node-verify.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const routes = new Map()
const mod = await import(pathToFileURL(path.join(process.cwd(), 'lib', 'index.js')).href)
mod.apply({
  logger: { info: () => {}, warn: m => console.error('  [warn]', m) },
  effect(fn) { const d = fn(); return () => { if (typeof d === 'function') d() } },
  inject() {},
  webServer: { register(r) { routes.set(r.path, r); return () => {} } },
})
await new Promise(r => setTimeout(r, 2500))
const prefix = JSON.parse(fs.readFileSync('defaults.json', 'utf8')).http.prefix

async function hit(method, p, body) {
  const route = routes.get(p)
  if (!route) return { json: { error: 'not registered' } }
  const chunks = []
  const listeners = new Map()
  const req = {
    method, url: p,
    headers: body !== undefined ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(JSON.stringify(body))) } : {},
    on(e, fn) { listeners.set(e, fn); return req },
    destroy() {},
  }
  const res = {
    statusCode: 0, headersSent: false,
    writeHead(s) { this.statusCode = s; this.headersSent = true },
    end(p2) { if (p2 !== undefined) chunks.push(Buffer.from(String(p2))) },
    destroy() {},
  }
  const running = route.handler(req, res)
  // **轮询等 data listener 挂上再投递**：handler 在 readJsonBody 前有
  // await targetOf()（PowerShell 发现，耗时数百 ms），固定延迟不可靠。
  // 真实 HTTP 栈会缓冲请求直到 handler 读取，桩必须模拟同样的「不丢」语义。
  const bodyStr = body !== undefined ? JSON.stringify(body) : null
  await new Promise((resolve) => {
    const t0 = Date.now()
    const iv = setInterval(() => {
      if (listeners.has('data') || Date.now() - t0 > 30000) {
        clearInterval(iv)
        resolve()
      }
    }, 10)
  })
  if (bodyStr !== null) {
    const d = listeners.get('data')
    if (d) d(Buffer.from(bodyStr))
  }
  const e = listeners.get('end')
  if (e) e()
  await running
  let json = null
  try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {}
  return { status: res.statusCode, json }
}

const info = '剩余流量：8.37 GB'

// 1. 列表过滤
const list = await hit('GET', `${prefix}/nodes`)
const names = (list.json?.nodes ?? []).map(n => n.name)
const leaked = names.filter(n => /剩余流量|套餐到期|官网|订阅|expire|traffic/i.test(n))
console.log(`  列表 ${names.length} 个节点，信息节点泄漏: ${leaked.length === 0 ? '✔ 无' : '✘ ' + leaked.join(', ')}`)

// 2. pick 拒绝
const pick = await hit('POST', `${prefix}/nodes`, { node: info })
console.log(`  pick「${info}」:`)
console.log(`    ok=${pick.json?.ok}  error=${pick.json?.error ?? '(空)'}  picked=${pick.json?.picked || '-'}`)
console.log(`  ${pick.json?.ok === false && pick.json?.error ? '✔ 正确拒绝' : '✘ 仍然放行'}`)

process.exit(pick.json?.ok === false ? 0 : 1)
