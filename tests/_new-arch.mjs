import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const routes = new Map()
const mod = await import(pathToFileURL(path.join(process.cwd(), 'lib', 'index.js')).href)
// 用真实的 ctx 模拟
const effects = []
const ctx = {
  logger: { info: () => {}, warn: m => console.error('  [warn]', m) },
  effect(fn, label) { effects.push({ fn, label }) },
  inject() {},
  webServer: { register(r) { routes.set(r.path, r); return () => routes.delete(r.path) } },
}
mod.apply(ctx)
console.log('  装配的 effect:', effects.map(e => e.label))
for (const e of effects) { try { e.fn() } catch (err) { console.error('  effect 失败', e.label, err.message) } }
await new Promise(r => setTimeout(r, 12000))
const prefix = JSON.parse(fs.readFileSync('defaults.json', 'utf8')).http.prefix
async function hit(p) {
  const route = routes.get(p)
  if (!route) return { error: 'not registered' }
  const chunks = []; const listeners = new Map()
  const req = { method: 'GET', url: p, headers: {}, on(e, fn) { listeners.set(e, fn); return req }, destroy() {} }
  const res = { statusCode: 0, headersSent: false, writeHead(s) { this.statusCode = s }, end(p2) { if (p2) chunks.push(Buffer.from(String(p2))) }, destroy() {} }
  const t0 = Date.now()
  const running = route.handler(req, res)
  setTimeout(() => { const e = listeners.get('end'); if (e) e() }, 0)
  await running
  return { ms: Date.now() - t0, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }
}
const a = await hit(`${prefix}/ip`)
console.log('')
console.log(`  /ip 读快照: ${a.ms}ms  ← 应该是毫秒级！`)
console.log(`  verdict=${a.json.verdict} age=${a.json.age}ms running=${a.json.running} factors=${(a.json.factors??[]).length}`)
const b = await hit(`${prefix}/ip`)
console.log(`  第2次: ${b.ms}ms`)
