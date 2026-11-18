/**
 * 端到端测试：打真实的本机 Clash Verge。
 *
 * 只做**读**和**可逆**操作：读状态、跑审计、列节点；切模式时记录原值并复原。
 * 跑法：node tests/live.test.mjs
 */
import assert from 'node:assert/strict'

import { loadConfig } from '../lib/settings.js'
import { resolve, describeCandidates } from '../lib/discover.js'
import { takeSnapshot } from '../lib/snapshot.js'
import { getJson, request } from '../lib/mihomo.js'
import { stateFile } from '../lib/paths.js'
import * as guard from '../lib/guard.js'
import * as win from '../lib/windows.js'

const { config } = loadConfig()
const paths = { stateFile: stateFile() }

const line = (label, value) => console.log(`  ${label.padEnd(22)} ${value}`)
const head = (title) => console.log(`\n=== ${title} ===`)

head('1. 控制器发现 + 探测')
const found = await resolve({ settings: config, defaults: config })
line('ok', String(found.ok))
line('candidates', String(found.discovered.candidates.length))
for (const row of describeCandidates(found.discovered)) {
  line('candidate', row)
}
console.log('')
for (const attempt of found.attempts) {
  line(attempt.ok ? 'PROBE OK' : 'probe fail', `${attempt.source} → ${attempt.error ?? attempt.version}`)
}
line('mixedPort', String(found.discovered.mixedPort))
line('mixedPortSource', found.discovered.mixedPortSource)
line('secret', found.discovered.secret === '' ? '(empty)' : `(len=${found.discovered.secret.length})`)
assert.equal(found.ok, true, '必须至少有一个候选能应答 /version')

const target = found.target
head('2. 命中的 target')
line('transport', target.transport)
line('pipe', target.pipe === '' ? '(none)' : `${target.pipe.slice(0, 24)}… (len=${target.pipe.length})`)
line('source', target.source)
line('modeFile', target.modeFile || '(none)')
line('storedMode', target.storedMode || '(none)')
line('runtimeDirs', String(found.discovered.runtimeDirs.length))

head('3. 配置快照（API + 配置文件合并）')
const snap = await takeSnapshot({ target: { ...target, runtimeDirs: found.discovered.runtimeDirs }, config })
line('yamlFile', snap.yamlFile || '(none)')
line('mode', String(snap.mode))
line('mixedPort', String(snap.mixedPort))
line('tun.enable', `${snap.tun.enable} (${snap.sources['tun.enable']})`)
line('tun.stack', `${snap.tun.stack} (${snap.sources['tun.stack']})`)
line('tun.autoRoute', `${snap.tun.autoRoute} (${snap.sources['tun.auto-route']})`)
line('tun.strictRoute', `${snap.tun.strictRoute} (${snap.sources['tun.strict-route']})`)
line('tun.dnsHijack', `${JSON.stringify(snap.tun.dnsHijack)} (${snap.sources['tun.dns-hijack']})`)
line('dns.enable', `${snap.dns.enable} (${snap.sources['dns.enable']})`)
line('dns.enhancedMode', `${snap.dns.enhancedMode} (${snap.sources['dns.enhanced-mode']})`)
line('dns.fakeIpRange', `${snap.dns.fakeIpRange} (${snap.sources['dns.fake-ip-range']})`)
line('dns.hijack', `${JSON.stringify(snap.dns.hijack)} (${snap.sources['dns.hijack']})`)

assert.notEqual(snap.mode, undefined, 'mode 必须解析出来')
assert.notEqual(snap.tun.enable, undefined, 'TUN 开关必须解析出来')
assert.notEqual(snap.dns.enhancedMode, undefined, 'DNS 模式必须从配置文件补上')

head('4. 选择器组')
const group = await getJson(target, `/proxies/${encodeURIComponent(config.bypass.selectorGroup)}`)
line('group', config.bypass.selectorGroup)
line('type', String(group.type))
line('now', String(group.now))
line('all.length', String(Array.isArray(group.all) ? group.all.length : 0))
assert.ok(Array.isArray(group.all) && group.all.length > 0, '选择器组必须有成员')

head('5. 连接表')
const conns = await getJson(target, '/connections')
const list = Array.isArray(conns.connections) ? conns.connections : []
const chains = {}
for (const c of list) {
  const k = Array.isArray(c.chains) && c.chains.length > 0 ? c.chains.join('>') : '(none)'
  chains[k] = (chains[k] ?? 0) + 1
}
line('total', String(list.length))
line('chains', JSON.stringify(chains).slice(0, 220))

head('6. 物理网卡与 IPv6')
const adapter = await win.resolvePhysicalAdapter(config.windows, config.discovery)
line('adapter', adapter.alias || '(none)')
line('index', String(adapter.index))
const v6 = await win.readIpv6State(config.windows, config.discovery)
line('ipv6Bound', String(v6.ipv6Bound))
line('global6', v6.globalAddresses.join(',') || '(none)')

head('7. 系统代理 / WinHTTP / DoH')
const sp = await win.readSystemProxy(config.windows)
line('wininet.enabled', String(sp.enabled))
line('wininet.server', sp.server || '(empty)')
line('wininet.override', sp.override.slice(0, 60) || '(empty)')
const wh = await win.readWinHttpProxy(config.windows)
line('winhttp.configured', String(wh.configured))
const doh = await win.readDohState(config.windows)
line('autoDoh', String(doh.autoDoh))
line('dohEntries', String(doh.entries.length))

head('8. DNS 服务器')
const dns = await win.readDnsServers(config.windows)
for (const row of dns) {
  line(`${row.alias}#${row.index}`, `v4=[${row.v4.join(',')}] v6=[${row.v6.join(',')}]`)
}
const tunDns = await win.readTunDns(config.windows, config.discovery)
line('tun.adapter', tunDns.adapter || '(none)')
line('tun.servers', tunDns.servers.join(',') || '(none)')

head('9. 管理员权限')
line('elevated', String(await win.isElevated(config.windows)))

head('10. 泄漏审计')
const audit = await guard.audit({
  target: { ...target, runtimeDirs: found.discovered.runtimeDirs },
  config,
  paths,
})
line('verdict', audit.verdict)
line('egressIp', String(audit.snapshot.egressIp))
line('realIp', String(audit.snapshot.realIp))
console.log('')
for (const check of audit.checks) {
  const mark = check.ok ? '✔' : '✘'
  console.log(`  ${mark} [${check.severity.padEnd(8)}] ${check.title}`)
  console.log(`      ${check.detail}`)
}
assert.ok(['safe', 'leaking', 'unprotected'].includes(audit.verdict), '裁决必须是三态之一')
assert.ok(audit.checks.length >= 10, '审计项不能少于 10 条')

head('11. 模式往返（可逆）')
const original = String(snap.mode)
line('original', original)
const flipped = original === config.modes.global ? config.modes.rule : config.modes.global
const patch = await request(target, 'PATCH', '/configs', { mode: flipped })
line('patch', `${patch.status} ${patch.ok}`)
assert.equal(patch.ok, true, 'PATCH 必须成功')
const after = await getJson(target, '/configs')
line('after', String(after.mode))
assert.equal(after.mode, flipped, '切换后回读必须一致')
const restore = await request(target, 'PATCH', '/configs', { mode: original })
line('restore', `${restore.status} ${restore.ok}`)
const final = await getJson(target, '/configs')
line('final', String(final.mode))
assert.equal(final.mode, original, '必须复原到原始模式')

head('\n全部通过')
