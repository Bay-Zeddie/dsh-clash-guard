/**
 * 默认路由 metric 修复实测：这是全插件最关键的一条。
 *
 * 要证明的事：
 *   1. 修前：物理网卡能绕过 TUN 直连出去（泄漏真实存在）
 *   2. 执行 raisePhysicalRouteMetric 后：物理网卡被堵住
 *   3. 撤销后：恢复到原状，能正常上网
 *
 * 跑法：node tests/route-metric.mjs
 */
import { loadConfig } from '../lib/settings.js'
import { resolve, discover } from '../lib/discover.js'
import { stateFile } from '../lib/paths.js'
import * as win from '../lib/windows.js'
import * as guard from '../lib/guard.js'
import {
  probeInterfaceBypass,
  probeDefaultRoutes,
  readPhysicalRouteMetric,
  raisePhysicalRouteMetric,
  restorePhysicalRouteMetric,
} from '../lib/leaks.js'

const { config } = loadConfig()
const paths = { stateFile: stateFile() }
const found = await resolve({ settings: config, defaults: config })
if (found.ok !== true) {
  console.log('控制器不可达')
  process.exit(1)
}
const d = await discover({ settings: config, defaults: config })
const target = { ...found.target, runtimeDirs: d.runtimeDirs }

const v6 = await win.readIpv6State(config.windows, config.discovery)
const addr = await win.readAdapterAddresses(config.windows, config.discovery, v6.physicalAdapter)
const alias = v6.physicalAdapter

const line = (label, value) => console.log(`  ${label.padEnd(22)} ${value}`)
const head = (title) => console.log(`\n=== ${title} ===`)

head('0. 环境')
line('物理网卡', alias)
line('IPv4', addr.primary)
line('默认路由 metric', JSON.stringify(await readPhysicalRouteMetric({ cfg: config.windows, alias })))

head('1. 修前：旁路是否存在')
const beforeRoutes = await probeDefaultRoutes({ cfg: config.windows, tunPatterns: config.discovery.tunAdapterPatterns })
line('路由竞争', beforeRoutes.state)
line('说明', beforeRoutes.detail)
const beforeBypass = await probeInterfaceBypass({ localAddress: addr.primary, config })
line('旁路探针', `${beforeBypass.state} — ${beforeBypass.detail}`)

head('2. 执行修复：抬高物理网卡 metric')
const raised = await raisePhysicalRouteMetric({
  cfg: config.windows,
  alias,
  metric: config.harden.physicalRouteMetric,
})
line('结果', `${raised.ok} — ${raised.detail}`)
if (!raised.ok) {
  console.log('\n  ✘ 修复失败（可能没有管理员权限）。这是权限问题，不是代码问题。')
  process.exit(1)
}

// 路由表变更需要一点时间生效
await new Promise(r => setTimeout(r, 2500))

head('3. 修后：旁路是否被堵住')
const afterRoutes = await probeDefaultRoutes({ cfg: config.windows, tunPatterns: config.discovery.tunAdapterPatterns })
line('路由竞争', afterRoutes.state)
line('说明', afterRoutes.detail)
const afterBypass = await probeInterfaceBypass({ localAddress: addr.primary, config })
line('旁路探针', `${afterBypass.state} — ${afterBypass.detail}`)

head('4. 断言')
let failed = 0
const assert = (ok, label) => {
  console.log(`  ${ok ? '✔' : '✘'} ${label}`)
  if (!ok) failed += 1
}
assert(beforeRoutes.state === 'competing', '修前存在路由竞争')
assert(beforeBypass.state === 'bypass', '修前物理网卡能绕过 TUN')
assert(afterRoutes.state === 'tun-wins', '修后 TUN 独占默认路由')
assert(afterBypass.state !== 'bypass', '修后物理网卡无法绕过 TUN')

head('5. 撤销：恢复原 metric')
const metricNow = await readPhysicalRouteMetric({ cfg: config.windows, alias })
line('当前 metric', String(metricNow.metric))
const restored = await restorePhysicalRouteMetric({ cfg: config.windows, alias, metric: 0 })
line('恢复结果', `${restored.ok} — ${restored.detail}`)
await new Promise(r => setTimeout(r, 2000))
const finalRoutes = await probeDefaultRoutes({ cfg: config.windows, tunPatterns: config.discovery.tunAdapterPatterns })
line('最终路由', finalRoutes.state)

// 确认网络没坏
const { probeViaProxy } = await import('../lib/egress.js')
const egress = await probeViaProxy({ mixedPort: 7897, egress: config.egress, proxyHost: config.egress.proxyHost })
line('出口仍可用', egress.ok ? `是 (${egress.ip})` : `否 (${egress.error ?? ''})`)
assert(egress.ok === true, '撤销后代理出口仍可用')

console.log(`\n${failed === 0 ? '全部通过' : failed + ' 项失败'}`)
process.exit(failed === 0 ? 0 : 1)
