/**
 * 整机出口探测实测：三条路径分别拿到什么。
 *
 * 跑法：node tests/egress-paths.mjs
 */
import { loadConfig } from '../lib/settings.js'
import { resolve } from '../lib/discover.js'
import * as win from '../lib/windows.js'
import { probeSystemEgress, probeBoundEgress, probeViaProxy } from '../lib/egress.js'
import { readState } from '../lib/guard.js'
import { stateFile } from '../lib/paths.js'

const { config } = loadConfig()
const found = await resolve({ settings: config, defaults: config })

const v6 = await win.readIpv6State(config.windows, config.discovery)
const adapter = await win.readAdapterAddresses(config.windows, config.discovery, v6.physicalAdapter)
const state = readState({ stateFile: stateFile() })
const realIp = typeof state.realIp === 'string' ? state.realIp : ''

const line = (label, value) => console.log(`  ${label.padEnd(26)} ${value}`)

console.log('=== 环境 ===')
line('物理网卡', v6.physicalAdapter)
line('网卡 IPv4', adapter.primary || '(无)')
line('校准真 IP', realIp || '(未校准)')
line('控制器', found.ok ? '可达' : '不可达')

console.log('\n=== 三条路径 ===')
const [system, bound] = await Promise.all([
  probeSystemEgress({ egress: config.egress }),
  probeBoundEgress({ localAddress: adapter.primary, egress: config.egress }),
])

let proxy = { ok: false, ip: '', detail: '控制器不可达' }
if (found.ok) {
  const one = await probeViaProxy({
    mixedPort: Number(found.target.mixedPort ?? 0),
    egress: config.egress,
    proxyHost: config.egress.proxyHost,
  })
  proxy = { ok: one.ok === true, ip: one.ok ? one.ip : '', detail: one.ok ? '' : '失败' }
}

line('① 系统出口（默认路由）', system.ok ? system.ip : `不可用（${system.detail ?? ''}）`)
line('② 代理出口（混合端口）', proxy.ok ? proxy.ip : `不可用（${proxy.detail}）`)
line('③ 绑卡出口（物理网卡）', bound.ok ? bound.ip : `不可用（${bound.detail}）`)

console.log('\n=== 判定 ===')
const exposed = []
if (realIp !== '') {
  if (system.ok && system.ip === realIp) exposed.push('系统')
  if (proxy.ok && proxy.ip === realIp) exposed.push('代理')
  if (bound.ok && bound.ip === realIp) exposed.push('绑卡')
}

if (realIp === '') {
  console.log('  未校准 → 无法判定暴露')
} else if (exposed.length > 0) {
  console.log(`  ✘ 真 IP 暴露于：${exposed.join('、')} 路径`)
} else if (bound.ok) {
  console.log('  ⚠ 绑卡可出网（当前拿到的不是真 IP，但这条路是活的）')
} else if (proxy.ok) {
  console.log('  ✔ 三条路径都被遮住')
} else {
  console.log('  ? 全部不可用')
}

console.log('\n=== 关键对照 ===')
console.log('  系统出口 vs 代理出口：')
console.log(`    系统 ${system.ip || '—'}  /  代理 ${proxy.ip || '—'}`)
if (system.ip && proxy.ip && system.ip !== proxy.ip) {
  console.log('    → 不同：说明系统流量与代理流量走了不同的出口（TUN 与 mixed-port 分开）')
} else if (system.ip && proxy.ip) {
  console.log('    → 相同：系统流量与代理流量同一个出口')
}

// 这是一份**诊断报告**，不是断言测试：
// 每条路径的成败取决于机器当前状态（TUN 开没开、真 IP 校没校准），
// 用退出码表达「通过/失败」没有意义。要断言请看 egress-verdict.test.mjs。
process.exit(0)
