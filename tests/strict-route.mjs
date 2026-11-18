/**
 * strict-route 三方对照：API / 文件 / 实际效果。
 * 跑法：node tests/strict-route.mjs
 */
import fs from 'node:fs'
import { loadConfig } from '../lib/settings.js'
import { resolve, discover } from '../lib/discover.js'
import { getJson } from '../lib/mihomo.js'
import { takeSnapshot } from '../lib/snapshot.js'
import * as win from '../lib/windows.js'
import { probeInterfaceBypass } from '../lib/leaks.js'

const { config } = loadConfig()
const found = await resolve({ settings: config, defaults: config })
if (found.ok !== true) {
  console.log('控制器不可达')
  process.exit(1)
}
const d = await discover({ settings: config, defaults: config })
const target = { ...found.target, runtimeDirs: d.runtimeDirs }

const snap = await takeSnapshot({ target, config })
const apiCfg = await getJson(target, '/configs')

console.log('=== strict-route 三方对照 ===')
console.log('  API  (getConfigs) :', apiCfg.tun?.['strict-route'], '  ← mihomo 的 GetGeneral 不含此字段')
console.log('  文件 (runtime)     :', snap.tun.strictRoute, '  来源:', snap.sources['tun.strict-route'])
console.log('  文件路径           :', snap.yamlFile)

const yaml = fs.readFileSync(snap.yamlFile, 'utf8')
const lines = yaml.replace(/\r\n/g, '\n').split('\n')
const start = lines.findIndex(line => /^tun:/.test(line))
console.log('\n=== 文件里的 tun 块 ===')
for (let i = start; i < Math.min(start + 18, lines.length); i += 1) {
  if (i > start && /^\S/.test(lines[i]) && lines[i].trim() !== '') break
  console.log(`  ${lines[i]}`)
}

console.log('\n=== 实际效果（绑物理网卡能否连出去）===')
const v6 = await win.readIpv6State(config.windows, config.discovery)
const addr = await win.readAdapterAddresses(config.windows, config.discovery, v6.physicalAdapter)
console.log('  网卡:', v6.physicalAdapter, ' IPv4:', addr.primary)
const bypass = await probeInterfaceBypass({ localAddress: addr.primary, config })
console.log('  探针:', bypass.state, '|', bypass.detail)

console.log('\n=== 判定 ===')
if (snap.tun.strictRoute === true && bypass.state === 'bypass') {
  console.log('  ✘ 配置写了 strict-route: true，但物理网卡仍能出去')
  console.log('    → 严格路由在 Windows 上没生效。这是 mihomo 的已知行为：')
  console.log('      strict-route 依赖自动路由表注入，若 TUN 未真正接管默认路由则形同虚设。')
  console.log('    → 插件必须报红（interface-bypass 检查项），不能只信配置值。')
} else if (snap.tun.strictRoute !== true) {
  console.log('  → strict-route 未开启；旁路存在是预期行为，插件报红正确。')
} else {
  console.log('  ✔ strict-route 开启且旁路被堵住。')
}
