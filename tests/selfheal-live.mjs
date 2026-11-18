/**
 * 自愈实测：制造真实故障 → 验证能检测出来 → 验证能修好。
 *
 * 这是本插件**最重要的安全测试**：它防的是「Clash 死了但 DNS 还指着它」
 * 那种整机断网事故。
 *
 * 跑法：node tests/selfheal-live.mjs
 *
 * ⚠️ 会真的改本机 DNS。脚本结束前一定恢复。
 */
import { loadConfig } from '../lib/settings.js'
import { discover } from '../lib/discover.js'
import * as win from '../lib/windows.js'
import {
  inspectNetwork,
  healNetwork,
  resetAdapterDns,
  flushDns,
  isTunnelDns,
} from '../lib/selfheal.js'

const { config } = loadConfig()
const discovered = await discover({ settings: config, defaults: config })

const line = (label, value) => console.log(`  ${String(label).padEnd(24)} ${value}`)
const head = (title) => console.log(`\n=== ${title} ===`)

/* ---------------- 0. 基线 ---------------- */

head('0. 当前状态')
const baseline = await inspectNetwork({ config, discovered })
line('裁决', baseline.verdict)
line('内核在跑', String(baseline.coreRunning))
line('物理网卡', baseline.adapter || '(未识别)')
line('DNS', baseline.dnsServers.join(', ') || '(空)')
line('隧道 DNS', baseline.tunnelDns.join(', ') || '(无)')
line('系统代理', baseline.proxyEnabled ? baseline.proxyServer : '关闭')
line('TUN 网卡', String(baseline.tunPresent))
if (baseline.problems.length > 0) {
  for (const p of baseline.problems) line(`  ⚠ ${p.id}`, p.title)
}

const adapter = baseline.adapter
if (adapter === '') {
  console.log('\n✘ 识别不到物理网卡，无法做破坏性测试')
  process.exit(1)
}

// 记下原始 DNS，最后必须还原
const originalDns = baseline.dnsServers.slice()
line('原始 DNS（待还原）', originalDns.join(', ') || '(自动获取)')

/* ---------------- 1. isTunnelDns 单元 ---------------- */

head('1. isTunnelDns 判定')
const cases = [
  ['198.18.0.2', true],
  ['198.18.0.19', true],
  ['198.19.255.1', true],
  ['10.252.28.18', false],
  ['223.5.5.5', false],
  ['', false],
]
let unitFail = 0
for (const [ip, want] of cases) {
  const got = isTunnelDns(ip, config.leaks.fakeIpRange)
  const ok = got === want
  if (!ok) unitFail++
  console.log(`  ${ok ? '✔' : '✘'} ${JSON.stringify(ip)} -> ${got}（期望 ${want}）`)
}

/* ---------------- 2. 制造故障 ---------------- */

head('2. 制造故障：把 DNS 指向隧道地址')
const injected = await win.pointDns(config.windows, adapter, config.leaks.interfaceProbe.host === '' ? '198.18.0.2' : '198.18.0.2')
line('注入 198.18.0.2', injected.ok ? '成功' : `失败：${injected.error ?? ''}`)
await flushDns(config.windows)
await new Promise(r => setTimeout(r, 1500))

const dnsNow = await win.readDnsServers(config.windows)
const physNow = dnsNow.find(x => x.alias === adapter)
line('实际 DNS', physNow?.v4?.join(', ') ?? '(空)')

/* ---------------- 3. 检测 ---------------- */

head('3. 检测能否发现')

/**
 * 用「内核已死」的假环境跑检测。
 *
 * **不能真杀内核**：服务会在 ~5 秒内把它拉回来，而且真杀会让 DNS 检测
 * 在服务拉起的窗口期里结果抖动。这里用一个把 coreProcessNames 改成
 * 必然不存在的名字的配置 —— 检测逻辑看到的就是「内核没跑」，而真机
 * 什么都不受影响。DNS 的注入是真的（要真改），内核状态是模拟的（不能真死）。
 */
const deadConfig = JSON.parse(JSON.stringify(config))
deadConfig.core.coreProcessNames = ['definitely-not-running-probe']

const broken = await inspectNetwork({ config: deadConfig, discovered })
line('裁决', broken.verdict)
line('隧道 DNS', broken.tunnelDns.join(', ') || '(无)')
line('模拟的内核状态', '未运行（假环境）')
const detected = broken.problems.some(p => p.id === 'dns-dead-tunnel')
console.log(`  ${detected ? '✔' : '✘'} 检出「DNS 指向死隧道地址」`)

// 对照：真环境（内核活着）下同样有这条 DNS，但**不该**报警
const withKernel = await inspectNetwork({ config, discovered })
const falsePositive = withKernel.problems.some(p => p.id === 'dns-dead-tunnel')
console.log(`  ${falsePositive ? '✘ 误报' : '✔ 不误报'} 内核活着时同样指向 198.18.0.2 —— 这是正常状态`)

/* ---------------- 4. 自愈 ---------------- */

head('4. 自愈')
const healed = await healNetwork({ config, report: broken })
line('修前', healed.before)
line('修后', healed.after)
for (const action of healed.actions) {
  line(`  ${action.ok ? '✔' : '✘'} ${action.id}`, String(action.detail).slice(0, 80))
}
if (healed.remaining.length > 0) {
  for (const p of healed.remaining) line(`  残留 ${p.id}`, p.title)
}

/* ---------------- 5. 验证真的好了 ---------------- */

head('5. 验证网络可用')
await new Promise(r => setTimeout(r, 1500))
const after = await inspectNetwork({ config, discovered })
line('裁决', after.verdict)
line('DNS', after.dnsServers.join(', ') || '(空)')

// 真解析一次
const { execFile } = await import('node:child_process')
const resolveOk = await new Promise((resolve) => {
  execFile('powershell', ['-NoProfile', '-Command', 'Resolve-DnsName www.baidu.com -Type A -QuickTimeout | Select-Object -First 1 -ExpandProperty IPAddress'], { timeout: 15000 }, (error, stdout) => {
    resolve(!error && String(stdout).trim().length > 0 ? String(stdout).trim() : '')
  })
})
line('解析 www.baidu.com', resolveOk !== '' ? `${resolveOk} ✔` : '失败 ✘')

/* ---------------- 6. 还原 ---------------- */

head('6. 还原到基线')
if (originalDns.length === 0) {
  const reset = await resetAdapterDns(config.windows, adapter)
  line('重置为自动获取', reset.ok ? '成功' : `失败：${reset.error ?? ''}`)
} else {
  const back = await win.pointDns(config.windows, adapter, originalDns[0])
  line(`还原为 ${originalDns[0]}`, back.ok ? '成功' : `失败：${back.error ?? ''}`)
}
await flushDns(config.windows)
await new Promise(r => setTimeout(r, 1000))

const final = await win.readDnsServers(config.windows)
const physFinal = final.find(x => x.alias === adapter)
line('最终 DNS', physFinal?.v4?.join(', ') ?? '(空)')

/* ---------------- 断言 ---------------- */

head('结论')
let failed = unitFail
const assert = (ok, label) => {
  console.log(`  ${ok ? '✔' : '✘'} ${label}`)
  if (!ok) failed++
}
assert(unitFail === 0, 'isTunnelDns 判定正确')
assert(injected.ok === true, '成功注入故障 DNS')
assert(detected === true, '检出故障')
assert(healed.after !== 'broken', '自愈后不再是 broken')
assert(resolveOk !== '', '自愈后域名解析可用')

console.log(`\n${failed === 0 ? '全部通过' : failed + ' 项失败'}`)
process.exit(failed === 0 ? 0 : 1)
