/**
 * 摘除网关实测：验证这是否真能堵住「绑卡直连」。
 *
 * 要证明的因果链：
 *   1. 有网关时：绑卡能连出去（泄漏）
 *   2. 摘掉网关后：绑卡连不出去（堵住）
 *   3. 恢复网关后：一切正常（可回滚）
 *   4. 全程 TUN 与代理出口不受影响（不误伤）
 *
 * 跑法：node tests/gateway-block.mjs
 */
import { loadConfig } from '../lib/settings.js'
import { resolve } from '../lib/discover.js'
import * as win from '../lib/windows.js'
import { probeViaProxy } from '../lib/egress.js'
import {
  probeInterfaceBypass,
  blockPhysicalGateway,
  restorePhysicalGateway,
} from '../lib/leaks.js'

const { config } = loadConfig()
const found = await resolve({ settings: config, defaults: config })
if (found.ok !== true) {
  console.log('控制器不可达')
  process.exit(1)
}
const v6 = await win.readIpv6State(config.windows, config.discovery)
const addr = await win.readAdapterAddresses(config.windows, config.discovery, v6.physicalAdapter)
const alias = v6.physicalAdapter

const line = (label, value) => console.log(`  ${label.padEnd(20)} ${value}`)
const head = (title) => console.log(`\n=== ${title} ===`)

const egressNow = () => probeViaProxy({
  mixedPort: 7897,
  egress: config.egress,
  proxyHost: config.egress.proxyHost,
})

head('0. 环境')
line('网卡', alias)
line('IPv4', addr.primary)
const e0 = await egressNow()
line('代理出口', e0.ok ? e0.ip : `不可用(${e0.error ?? ''})`)

head('1. 有网关时：绑卡能否连出')
const before = await probeInterfaceBypass({ localAddress: addr.primary, config })
line('旁路探针', `${before.state} — ${before.detail}`)

head('2. 摘除物理网卡默认网关')
const blocked = await blockPhysicalGateway({ cfg: config.windows, alias })
line('结果', String(blocked.ok))
line('详情', blocked.detail)
line('摘掉的路由', JSON.stringify(blocked.removed))

if (!blocked.ok) {
  console.log('\n  ✘ 摘除失败（可能没管理员权限）。')
  process.exit(1)
}

await new Promise(r => setTimeout(r, 2500))

head('3. 摘除后：绑卡还能连出吗')
const after = await probeInterfaceBypass({ localAddress: addr.primary, config })
line('旁路探针', `${after.state} — ${after.detail}`)

head('4. 摘除后：代理出口是否还正常（不能误伤）')
const e1 = await egressNow()
line('代理出口', e1.ok ? e1.ip : `不可用(${e1.error ?? ''})`)

head('5. 恢复网关')
const restored = await restorePhysicalGateway({
  cfg: config.windows,
  alias,
  routes: blocked.removed,
})
line('结果', String(restored.ok))
line('详情', restored.detail)
await new Promise(r => setTimeout(r, 2500))

head('6. 恢复后：一切正常')
const final = await probeInterfaceBypass({ localAddress: addr.primary, config })
line('旁路探针', `${final.state} — ${final.detail}`)
const e2 = await egressNow()
line('代理出口', e2.ok ? e2.ip : `不可用(${e2.error ?? ''})`)

head('7. 断言')
let failed = 0
const assert = (ok, label) => {
  console.log(`  ${ok ? '✔' : '✘'} ${label}`)
  if (!ok) failed += 1
}
assert(before.state === 'bypass', '摘前绑卡能连出（泄漏确认存在）')
assert(after.state !== 'bypass', '摘后绑卡连不出去（堵住成功）')
assert(e1.ok === true, '摘除期间代理出口不受影响（不误伤）')
assert(restored.ok === true, '网关可恢复')
assert(final.state === 'bypass', '恢复后回到原状（可回滚）')
assert(e2.ok === true, '恢复后代理出口正常')

console.log(`\n${failed === 0 ? '全部通过' : failed + ' 项失败'}`)
process.exit(failed === 0 ? 0 : 1)
