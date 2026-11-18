/**
 * 审计实测：18 项，含 3 个新探针。
 * 跑法：node 本文件
 */
import { loadConfig } from '../lib/settings.js'
import { resolve, discover } from '../lib/discover.js'
import { stateFile } from '../lib/paths.js'
import * as guard from '../lib/guard.js'

const { config } = loadConfig()
const paths = { stateFile: stateFile() }
const f = await resolve({ settings: config, defaults: config })
if (f.ok !== true) {
  console.log('控制器不可达')
  process.exit(1)
}
const d = await discover({ settings: config, defaults: config })
const t = { ...f.target, runtimeDirs: d.runtimeDirs }

console.log('=== 审计（含新增探针）===')
const started = Date.now()
const result = await guard.audit({ target: t, config, paths })
console.log(`耗时: ${Date.now() - started}ms   裁决: ${result.verdict}\n`)

for (const check of result.checks) {
  const mark = check.ok ? '✔' : '✘'
  const sev = check.severity.padEnd(8)
  const id = check.id.padEnd(18)
  console.log(`${mark} [${sev}] ${id} ${check.detail.slice(0, 90)}`)
}

const failed = result.checks.filter(check => !check.ok)
console.log(`\n失败项 (${failed.length}): ${failed.map(c => c.id).join(', ') || '无'}`)

console.log('\n=== 快照摘要 ===')
console.log('  出口 IP :', result.snapshot.egressIp)
console.log('  校准真IP:', result.snapshot.realIp)
console.log('  连接数  :', result.snapshot.totalConnections, '/ 直连', result.snapshot.directConnections)
console.log('  模式    :', result.snapshot.mode)
