import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const routes = new Map()
const effects = []
const mod = await import(pathToFileURL(path.join(process.cwd(), 'lib', 'index.js')).href)
const ctx = {
  logger: { info: () => {}, warn: m => console.error('  [warn]', m) },
  effect(fn, label) { effects.push({ fn, label }) },
  inject() {},
  webServer: { register(r) { routes.set(r.path, r); return () => routes.delete(r.path) } },
}
mod.apply(ctx)
for (const e of effects) { try { e.fn() } catch (err) { console.error('  effect 失败', e.label, err.message) } }
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
console.log('  启动后 30 秒实时性：')
let maxAge = 0
for (let i = 0; i < 15; i++) {
  const r = await hit(`${prefix}/ip`)
  const age = r.json.age
  if (typeof age === 'number') maxAge = Math.max(maxAge, age)
  const info = r.json.ready === true ? `age=${String(age).padStart(5)}ms tier=${r.json.tier}` : '(未建立)'
  console.log(`    t=${String(i*2).padStart(2)}s ${info}`)
  await new Promise(res => setTimeout(res, 2000))
}
console.log('')
console.log(`  最大快照年龄: ${maxAge}ms`)
