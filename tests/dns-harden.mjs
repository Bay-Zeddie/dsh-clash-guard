/**
 * DNS 加固实测：验证 PATCH 无效、PUT+改文件有效。
 * 跑法：node tests/dns-harden.mjs
 */
import { loadConfig } from '../lib/settings.js'
import { resolve, discover } from '../lib/discover.js'
import { stateFile } from '../lib/paths.js'
import { getJson, request } from '../lib/mihomo.js'
import * as guard from '../lib/guard.js'

const { config } = loadConfig()
const paths = { stateFile: stateFile() }
const found = await resolve({ settings: config, defaults: config })
if (found.ok !== true) {
  console.log('控制器不可达')
  process.exit(1)
}
const d = await discover({ settings: config, defaults: config })
const target = { ...found.target, runtimeDirs: d.runtimeDirs }

console.log('=== 1. 证明 PATCH dns 无效 ===')
const before = await getJson(target, '/configs')
console.log('  /configs 含 dns 字段?', Object.hasOwn(before, 'dns'))
const patchRes = await request(target, 'PATCH', '/configs', {
  dns: { enable: true, 'enhanced-mode': 'fake-ip' },
})
console.log('  PATCH {dns:...} ->', patchRes.status, '(204 = 假装成功)')
const afterPatch = await getJson(target, '/configs')
console.log('  之后 /configs 含 dns 字段?', Object.hasOwn(afterPatch, 'dns'), '（仍没有 = 被丢弃）')

console.log('\n=== 2. 用 /dns/query 验证 DNS 模块是否活着 ===')
try {
  const q = await getJson(target, `/dns/query?name=${encodeURIComponent(config.leaks.dnsProbeName)}&type=A`)
  const answers = Array.isArray(q?.Answer) ? q.Answer : []
  console.log('  答复条数:', answers.length)
  for (const a of answers.slice(0, 3)) console.log(`    ${a.name} type=${a.type} ${a.data}`)
} catch (error) {
  console.log('  /dns/query 失败:', String(error.message ?? error).slice(0, 120))
  console.log('  → 这本身说明 DNS 模块没启用')
}

console.log('\n=== 3. 走自己的 hardenDns（改文件 + PUT 重载）===')
const steps = await guard.harden({ target, config, paths })
for (const step of steps) {
  console.log(`  ${step.ok ? '✔' : '✘'} ${step.step.padEnd(18)} ${step.detail}`)
}

console.log('\n=== 4. 重载后再查 DNS ===')
try {
  const q2 = await getJson(target, `/dns/query?name=${encodeURIComponent(config.leaks.dnsProbeName)}&type=A`)
  const answers2 = Array.isArray(q2?.Answer) ? q2.Answer : []
  console.log('  答复条数:', answers2.length)
  for (const a of answers2.slice(0, 3)) console.log(`    ${a.name} type=${a.type} ${a.data}`)
} catch (error) {
  console.log('  /dns/query 仍失败:', String(error.message ?? error).slice(0, 120))
}

console.log('\n=== 5. 确认 mode 与 TUN 没被重载搞坏 ===')
const final = await getJson(target, '/configs')
console.log('  mode:', final.mode)
console.log('  tun.enable:', final.tun?.enable, ' stack:', final.tun?.stack)
console.log('  mixed-port:', final['mixed-port'])
