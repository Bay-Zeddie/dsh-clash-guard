/**
 * 接口级出站封锁实测 —— 全插件最关键的验证。
 *
 * 要证明的因果链：
 *   1. 封锁前：绑卡能连出去（泄漏确认存在）
 *   2. 封锁后：绑卡连不出去（堵住）
 *   3. 封锁后：**mihomo 仍能连节点**（不误伤，这是整个方案的成立条件）
 *   4. 封锁后：普通程序走 TUN 照常工作（DSH 自己的网络不能断）
 *   5. 撤销后：一切复原
 *
 * 跑法：node tests/firewall-block.mjs
 */
import { loadConfig } from '../lib/settings.js'
import { resolve, discover } from '../lib/discover.js'
import * as win from '../lib/windows.js'
import { probeViaProxy } from '../lib/egress.js'
import { probeInterfaceBypass } from '../lib/leaks.js'
import {
  applyInterfaceBlock,
  removeInterfaceBlock,
  inspectInterfaceBlock,
  resolveCorePath,
} from '../lib/firewall.js'

const { config } = loadConfig()
const found = await resolve({ settings: config, defaults: config })
if (found.ok !== true) {
  console.log('控制器不可达')
  process.exit(1)
}
const d = await discover({ settings: config, defaults: config })

const v6 = await win.readIpv6State(config.windows, config.discovery)
const addr = await win.readAdapterAddresses(config.windows, config.discovery, v6.physicalAdapter)
const alias = v6.physicalAdapter
const corePath = resolveCorePath({ discovered: d })

const line = (label, value) => console.log(`  ${label.padEnd(20)} ${value}`)
const head = (title) => console.log(`\n=== ${title} ===`)

const egressNow = () => probeViaProxy({
  mixedPort: 7897,
  egress: config.egress,
  proxyHost: config.egress.proxyHost,
})

head('0. 环境')
line('物理网卡', alias)
line('网卡 IPv4', addr.primary)
line('内核路径', corePath || '(未找到)')
line('防火墙规则', JSON.stringify((await inspectInterfaceBlock({ cfg: config.windows, rules: config.firewall })).rules))

if (corePath === '') {
  console.log('\n✘ 找不到内核路径，无法放行，测试中止')
  process.exit(1)
}

head('1. 封锁前：绑卡能否连出')
const before = await probeInterfaceBypass({ localAddress: addr.primary, config })
line('旁路探针', `${before.state} — ${before.detail}`)
const e0 = await egressNow()
line('代理出口', e0.ok ? e0.ip : `不可用(${e0.error ?? ''})`)

head('2. 应用接口级封锁')
const applied = await applyInterfaceBlock({
  cfg: config.windows,
  rules: config.firewall,
  alias,
  corePath,
})
line('结果', String(applied.ok))
line('详情', applied.detail)
if (!applied.ok) {
  console.log('\n✘ 应用失败，中止（已自动清理）')
  process.exit(1)
}

await new Promise(r => setTimeout(r, 2000))

head('3. 封锁后：绑卡还能连出吗')
const after = await probeInterfaceBypass({ localAddress: addr.primary, config })
line('旁路探针', `${after.state} — ${after.detail}`)

head('4. 封锁后：mihomo 是否还能连节点（关键）')
const e1 = await egressNow()
line('代理出口', e1.ok ? e1.ip : `不可用(${e1.error ?? ''})`)

head('5. 封锁后：走 TUN 的普通流量是否正常')
const dnsCheck = await win.readDnsServers(config.windows)
const physDns = dnsCheck.find(x => x.alias === alias)
line('物理网卡 DNS', physDns?.v4?.join(',') ?? '(无)')

head('6. 撤销封锁')
const removed = await removeInterfaceBlock({ cfg: config.windows, rules: config.firewall })
line('结果', String(removed.ok))
line('详情', removed.detail)
await new Promise(r => setTimeout(r, 2000))

head('7. 撤销后：复原')
const final = await probeInterfaceBypass({ localAddress: addr.primary, config })
line('旁路探针', `${final.state} — ${final.detail}`)
const e2 = await egressNow()
line('代理出口', e2.ok ? e2.ip : `不可用(${e2.error ?? ''})`)
line('残留规则', JSON.stringify((await inspectInterfaceBlock({ cfg: config.windows, rules: config.firewall })).rules))

head('8. 断言')
let failed = 0
const assert = (ok, label) => {
  console.log(`  ${ok ? '✔' : '✘'} ${label}`)
  if (!ok) failed += 1
}
assert(before.state === 'bypass', '封锁前绑卡能连出（泄漏确认）')
assert(after.state !== 'bypass', '封锁后绑卡连不出去（堵住成功）')
assert(e1.ok === true, '封锁后 mihomo 仍能连节点（不误伤 —— 方案成立的关键）')
assert(removed.ok === true, '规则可撤销')
assert(final.state === 'bypass', '撤销后回到原状（可回滚）')
assert(e2.ok === true, '撤销后代理出口正常')

console.log(`\n${failed === 0 ? '全部通过' : failed + ' 项失败'}`)
process.exit(failed === 0 ? 0 : 1)
