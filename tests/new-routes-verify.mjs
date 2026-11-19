/**
 * 新路由验证：/latency + /rules-stats
 * 跑法：node tests/new-routes-verify.mjs
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

async function hit(method, p) {
  const route = routes.get(p)
  if (!route) return { status: 0, json: { error: 'not registered' } }
  const chunks = []
  const listeners = new Map()
  const req = { method, url: p, headers: {}, on(e, fn) { listeners.set(e, fn); return req }, destroy() {} }
  const res = { statusCode: 0, headersSent: false, writeHead(s) { this.statusCode = s }, end(p2) { if (p2) chunks.push(Buffer.from(String(p2))) }, destroy() {} }
  const running = route.handler(req, res)
  setTimeout(() => { const e = listeners.get('end'); if (e) e() }, 0)
  await running
  let json = null
  try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {}
  return { status: res.statusCode, json }
}

console.log('--- GET /latency ---')
const lat = await hit('GET', `${prefix}/latency`)
console.log(`  ok=${lat.json?.ok} elapsed=${lat.json?.elapsed}ms entries=${lat.json?.entries?.length}`)
console.log(`  fastest: ${lat.json?.fastest ? `${lat.json.fastest.delay}ms ${lat.json.fastest.name.slice(0, 30)}` : '(无)'}`)
for (const e of (lat.json?.entries ?? []).slice(0, 5)) console.log(`    ${e.delay}ms ${e.name.slice(0, 36)}`)

console.log('\n--- GET /rules-stats ---')
const rs = await hit('GET', `${prefix}/rules-stats`)
console.log(`  ok=${rs.json?.ok} total=${rs.json?.total} active=${rs.json?.activeCount} dead=${rs.json?.deadCount} (${rs.json?.deadPercent}%)`)
for (const r of (rs.json?.topHits ?? []).slice(0, 5)) console.log(`    ${String(r.hits).padStart(6)} 次 [${r.type}] ${String(r.payload).slice(0, 30)} → ${r.proxy}`)
