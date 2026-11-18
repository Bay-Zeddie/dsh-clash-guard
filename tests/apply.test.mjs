/**
 * 加固测试：真实执行三段式切换，验证系统改动**完整复原**。
 *
 * 序列（每一步都有 finally 兜底）：
 *   记录原始状态 → global（加固）→ 验证加固生效 → off（自动撤销）→
 *   验证系统改动已复原 → 回到原始 mode。
 *
 * 跑法：node tests/apply.test.mjs
 *
 * 注意：这一步会真的改系统代理、DNS、IPv6 绑定。脚本用 finally 保证复原，
 * 并在最后断言所有系统状态与开始前一致。
 */
import assert from 'node:assert/strict'

import { loadConfig } from '../lib/settings.js'
import { resolve } from '../lib/discover.js'
import { takeSnapshot } from '../lib/snapshot.js'
import { stateFile } from '../lib/paths.js'
import * as guard from '../lib/guard.js'
import * as win from '../lib/windows.js'

const { config } = loadConfig()
const paths = { stateFile: stateFile() }

const line = (label, value) => console.log(`  ${label.padEnd(24)} ${value}`)
const head = (title) => console.log(`\n=== ${title} ===`)

/** 采集系统状态指纹，用于前后比对。 */
async function fingerprint() {
  const sp = await win.readSystemProxy(config.windows)
  const wh = await win.readWinHttpProxy(config.windows)
  const v6 = await win.readIpv6State(config.windows, config.discovery)
  const dns = await win.readDnsServers(config.windows)
  const phys = dns.find(d => d.alias === v6.physicalAdapter)
  const doh = await win.readDohState(config.windows)
  return {
    wininet: { enabled: sp.enabled, server: sp.server },
    winhttp: wh.configured,
    ipv6Bound: v6.ipv6Bound,
    physicalAdapter: v6.physicalAdapter,
    dns: phys === undefined ? [] : phys.v4.slice().sort(),
    autoDoh: doh.autoDoh,
  }
}

const found = await resolve({ settings: config, defaults: config })
assert.equal(found.ok, true, '控制器必须可达')
const target = { ...found.target, runtimeDirs: found.discovered.runtimeDirs }

head('0. 原始状态')
const before = await fingerprint()
const beforeSnap = await takeSnapshot({ target, config })
line('mode', String(beforeSnap.mode))
line('wininet.enabled', String(before.wininet.enabled))
line('wininet.server', before.wininet.server || '(empty)')
line('winhttp', String(before.winhttp))
line('ipv6Bound', `${before.ipv6Bound} (${before.physicalAdapter})`)
line('dns', before.dns.join(',') || '(empty)')
line('autoDoh', String(before.autoDoh))

let exitCode = 0
try {
  head('1. 切到 global（执行加固）')
  const toGlobal = await guard.switchMode({ mode: 'global', target, config, paths })
  line('ok', String(toGlobal.ok))
  line('effective', toGlobal.effective)
  line('persisted', `${toGlobal.persisted.ok} → ${toGlobal.persisted.file}`)
  for (const step of toGlobal.steps) {
    line(`${step.ok ? '✔' : '✘'} ${step.step}`, step.detail)
  }
  assert.equal(toGlobal.ok, true, 'global 切换必须成功')
  assert.equal(toGlobal.effective, config.modes.global, '内核必须真的在 global')

  head('2. 验证 global 下的加固结果')
  const afterGlobal = await fingerprint()
  const snapGlobal = await takeSnapshot({ target, config })
  line('mode', String(snapGlobal.mode))
  line('tun.enable', String(snapGlobal.tun.enable))
  line('tun.strictRoute', String(snapGlobal.tun.strictRoute))
  line('dns.enhancedMode', String(snapGlobal.dns.enhancedMode))
  line('wininet.enabled', String(afterGlobal.wininet.enabled))
  line('wininet.server', afterGlobal.wininet.server || '(empty)')
  line('ipv6Bound', String(afterGlobal.ipv6Bound))
  line('dns', afterGlobal.dns.join(',') || '(empty)')

  assert.equal(snapGlobal.mode, config.modes.global, '内核 mode 必须是 global')
  assert.equal(snapGlobal.tun.enable, true, 'TUN 必须开')
  assert.equal(snapGlobal.tun.strictRoute, true, '严格路由必须开')
  if (config.harden.systemProxy) {
    assert.equal(afterGlobal.wininet.enabled, true, '系统代理必须开')
    assert.ok(afterGlobal.wininet.server.includes(`:${found.discovered.mixedPort}`), '系统代理必须指向混合端口')
  }
  if (config.harden.disableIpv6) {
    assert.equal(afterGlobal.ipv6Bound, false, '物理网卡 IPv6 必须关断')
  }

  head('3. 跑一次 global 下的审计')
  const auditGlobal = await guard.audit({ target, config, paths })
  line('verdict', auditGlobal.verdict)
  line('egressIp', String(auditGlobal.snapshot.egressIp))
  for (const check of auditGlobal.checks) {
    if (!check.ok) line(`✘ ${check.id}`, check.detail)
  }
  assert.notEqual(auditGlobal.verdict, 'unprotected', 'global 下不应判为未受保护')

  head('4. 切到 off（自动撤销全部系统改动）')
  const toOff = await guard.switchMode({ mode: 'off', target, config, paths })
  line('ok', String(toOff.ok))
  line('effective', toOff.effective)
  for (const step of toOff.steps) {
    line(`${step.ok ? '✔' : '✘'} ${step.step}`, step.detail)
  }
  assert.equal(toOff.ok, true, 'off 切换必须成功')
  assert.equal(toOff.effective, config.modes.off, '内核必须真的在 direct')

  head('5. 验证系统改动已复原')
  const afterOff = await fingerprint()
  line('wininet.enabled', String(afterOff.wininet.enabled))
  line('wininet.server', afterOff.wininet.server || '(empty)')
  line('winhttp', String(afterOff.winhttp))
  line('ipv6Bound', String(afterOff.ipv6Bound))
  line('dns', afterOff.dns.join(',') || '(empty)')

  assert.equal(afterOff.wininet.enabled, false, '系统代理必须已关闭')
  assert.equal(afterOff.ipv6Bound, before.ipv6Bound, 'IPv6 绑定必须回到原值')
  assert.deepEqual(afterOff.dns, before.dns, '物理网卡 DNS 必须回到原值')
  assert.equal(afterOff.winhttp, before.winhttp, 'WinHTTP 必须回到原值')

  head('6. 复原到原始 mode')
  const originalName = guard.modeNameOf(config.modes, beforeSnap.mode)
  const restore = await guard.switchMode({ mode: originalName, target, config, paths })
  line('requested', originalName)
  line('ok', String(restore.ok))
  line('effective', restore.effective)
  assert.equal(restore.ok, true, '必须回到原始 mode')

  const finalSnap = await takeSnapshot({ target, config })
  line('final.mode', String(finalSnap.mode))
  assert.equal(finalSnap.mode, beforeSnap.mode, '最终 mode 必须与开始前一致')

  head('\n全部通过，系统状态已复原')
} catch (error) {
  exitCode = 1
  console.error('\n!!! 测试失败，开始强制复原 !!!')
  console.error(error)
  try {
    await win.clearSystemProxy(config.windows)
    await win.resetWinHttpProxy(config.windows)
    const v6 = await win.readIpv6State(config.windows, config.discovery)
    if (v6.physicalAdapter !== '') {
      if (v6.ipv6Bound !== before.ipv6Bound) {
        if (before.ipv6Bound) await win.enablePhysicalIpv6(config.windows, v6.physicalAdapter)
        else await win.disablePhysicalIpv6(config.windows, v6.physicalAdapter)
      }
      if (before.dns.length > 0) {
        await win.pointDns(config.windows, v6.physicalAdapter, before.dns[0])
      } else {
        await win.resetDns(config.windows, v6.physicalAdapter)
      }
    }
    const originalName = guard.modeNameOf(config.modes, beforeSnap.mode)
    await guard.switchMode({ mode: originalName, target, config, paths })
    console.log('强制复原完成')
  } catch (restoreError) {
    console.error('强制复原也失败了：', restoreError)
  }
}

process.exit(exitCode)
