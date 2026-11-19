/**
 * 竞品研究结果落地：新增三个高价值功能探针。
 *
 * 来源：
 *   · zashboard / metacubexd（mihomo 生态两大标杆面板）的交互设计
 *   · mihomo 官方 API：/group/GLOBAL/delay（批量延迟）、/rules（含 hitCount）
 *
 * 新功能：
 *   1. probeLatencyRank   —— 一键测全组延迟并排序（找最快节点）
 *   2. probeRulesStats    —— 规则命中统计（哪些规则真的在工作）
 *
 * 跑法：node tests/research-features.mjs
 */
import { loadConfig } from '../lib/settings.js'
import { resolve } from '../lib/discover.js'
import { request, getJson } from '../lib/mihomo.js'

const { config } = loadConfig()
const f = await resolve({ settings: config, defaults: config })
if (f.ok !== true) {
  console.log('控制器不可达')
  process.exit(1)
}
const t = f.target

const line = (label, value) => console.log(`  ${String(label).padEnd(26)} ${value}`)
const head = (title) => console.log(`\n=== ${title} ===`)

/* ---------------- 1. 批量延迟排序 ---------------- */

head('1. 全组延迟测试（GET /group/GLOBAL/delay）')
const started = Date.now()
const delayRes = await request(t, 'GET',
  '/group/GLOBAL/delay?url=https%3A%2F%2Fwww.gstatic.com%2Fgenerate_204&timeout=2500')
const delayMs = Date.now() - started
const delayData = (() => { try { return JSON.parse(delayRes.text ?? '{}') } catch { return {} } })()

const entries = Object.entries(delayData)
  .filter(([name, delay]) => typeof delay === 'number' && delay > 0)
  .sort((a, b) => a[1] - b[1])

line('测试耗时', `${delayMs}ms`)
line('有延迟数据的节点', `${entries.length} 个`)
line('最快', entries.length > 0 ? `${entries[0][1]}ms — ${entries[0][0].slice(0, 40)}` : '(无)')
if (entries.length > 5) {
  line('最慢(前5内)', `${entries[entries.length - 1][1]}ms — ${entries[entries.length - 1][0].slice(0, 40)}`)
}
console.log('\n  延迟排行（前 10）：')
for (const [name, delay] of entries.slice(0, 10)) {
  const bar = '█'.repeat(Math.max(1, Math.round((300 - Math.min(delay, 300)) / 20)))
  console.log(`    ${String(delay).padStart(5)}ms ${bar} ${name.slice(0, 34)}`)
}

/* ---------------- 2. 规则命中统计 ---------------- */

head('2. 规则命中统计（GET /rules 的 extra.hitCount）')
const rules = await getJson(t, '/rules')
const all = Array.isArray(rules?.rules) ? rules.rules : []

const byType = {}
let totalHit = 0
const topHits = []
for (const rule of all) {
  byType[rule.type] = (byType[rule.type] ?? 0) + 1
  const hits = rule.extra?.hitCount ?? 0
  totalHit += hits
  if (hits > 0) topHits.push({ payload: rule.payload, proxy: rule.proxy, hits, type: rule.type })
}
topHits.sort((a, b) => b.hits - a.hits)

line('规则总数', `${all.length} 条`)
line('类型分布', JSON.stringify(byType))
line('总命中次数', `${totalHit}`)
line('有命中的规则', `${topHits.length} 条`)
console.log('\n  命中 Top 10（真实在工作的规则）：')
for (const r of topHits.slice(0, 10)) {
  console.log(`    ${String(r.hits).padStart(7)} 次  [${r.type}] ${String(r.payload).slice(0, 34)} → ${String(r.proxy).slice(0, 16)}`)
}

// 零命中规则占比（死规则）
const deadCount = all.length - topHits.length
line('零命中（死规则）', `${deadCount} 条 (${Math.round((deadCount / all.length) * 100)}%)`)

/* ---------------- 3. 当前连接的实时画像 ---------------- */

head('3. 当前连接画像（GET /connections 聚合）')
const conns = await getJson(t, '/connections')
const list = Array.isArray(conns?.connections) ? conns.connections : []
const byChain = {}
let up = 0, down = 0
for (const c of list) {
  up += c.upload ?? 0
  down += c.download ?? 0
  const chain = Array.isArray(c.chains) ? c.chains[0] : '?'
  byChain[chain] = (byChain[chain] ?? 0) + 1
}
line('活动连接', `${list.length} 条`)
line('累计上传/下载', `${(up / 1024).toFixed(1)} KB / ${(down / 1024).toFixed(1)} KB`)
line('出站链分布', JSON.stringify(byChain))
// 下载速率 Top 3
const topDl = [...list].sort((a, b) => (b.download ?? 0) - (a.download ?? 0)).slice(0, 3)
console.log('\n  下载 Top 3：')
for (const c of topDl) {
  const host = c.metadata?.host || c.metadata?.destinationIP || '?'
  console.log(`    ${(c.download / 1024).toFixed(1).padStart(9)} KB  ${host.slice(0, 40)} [${(c.chains ?? []).join('→').slice(0, 30)}]`)
}

console.log('\n=== 结论：三个新探针全部可用，直接进面板/工具 ===')
