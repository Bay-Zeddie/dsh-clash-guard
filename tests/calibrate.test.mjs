/**
 * 校准流程测试：off 状态下采真 IP，global 状态下断言出口 ≠ 真 IP。
 *
 * 这是整个插件的目的验收：**开了全局，出口必须不是真 IP**。
 *
 * 跑法：node tests/calibrate.test.mjs
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

const found = await resolve({ settings: config, defaults: config })
assert.equal(found.ok, true, '控制器必须可达')
const target = { ...found.target, runtimeDirs: found.discovered.runtimeDirs }

const beforeSnap = await takeSnapshot({ target, config })
const originalName = guard.modeNameOf(config.modes, beforeSnap.mode)

let exitCode = 0
try {
  head('1. 切到 off（校准的前提）')
  const toOff = await guard.switchMode({ mode: 'off', target, config, paths })
  line('ok', String(toOff.ok))
  line('effective', toOff.effective)
  assert.equal(toOff.ok, true)

  head('2. 校准真 IP')
  const cal = await guard.calibrate({ target, config, paths })
  line('ok', String(cal.ok))
  line('ip', String(cal.ip))
  line('reason', cal.reason || '')
  assert.equal(cal.ok, true, '校准必须成功')
  assert.ok(/^\d+\.\d+\.\d+\.\d+$/.test(cal.ip) || cal.ip.includes(':'), '必须采到合法 IP')

  const realIp = cal.ip
  const state = guard.readState(paths)
  line('state.realIp', String(state.realIp))
  assert.equal(state.realIp, realIp, '真 IP 必须落盘')

  head('3. 切到 global')
  const toGlobal = await guard.switchMode({ mode: 'global', target, config, paths })
  line('ok', String(toGlobal.ok))
  line('effective', toGlobal.effective)
  for (const step of toGlobal.steps) {
    line(`${step.ok ? '✔' : '✘'} ${step.step}`, step.detail)
  }
  assert.equal(toGlobal.ok, true)

  head('4. 审计：出口 IP 必须 ≠ 真 IP')
  const audit = await guard.audit({ target, config, paths })
  line('verdict', audit.verdict)
  line('realIp', String(audit.snapshot.realIp))
  line('egressIp', String(audit.snapshot.egressIp))
  const diff = audit.snapshot.egressIp !== audit.snapshot.realIp
  line('出口 ≠ 真 IP', String(diff))
  assert.equal(diff, true, '全局模式下出口 IP 必须不等于真 IP —— 这是本插件的核心断言')

  const egressCheck = audit.checks.find(c => c.id === 'egress-vs-real')
  assert.ok(egressCheck !== undefined, '必须有 egress-vs-real 检查项')
  assert.equal(egressCheck.ok, true, 'egress-vs-real 必须通过')

  console.log('')
  for (const check of audit.checks) {
    line(`${check.ok ? '✔' : '✘'} ${check.id}`, check.detail.slice(0, 90))
  }

  head('5. 复原')
  const restore = await guard.switchMode({ mode: originalName, target, config, paths })
  line('requested', originalName)
  line('ok', String(restore.ok))
  const finalSnap = await takeSnapshot({ target, config })
  line('final.mode', String(finalSnap.mode))
  assert.equal(finalSnap.mode, beforeSnap.mode)

  head('\n核心断言通过：全局模式下真实 IP 未暴露')
} catch (error) {
  exitCode = 1
  console.error('\n!!! 失败，强制复原 !!!')
  console.error(error)
  try {
    await win.clearSystemProxy(config.windows)
    await win.resetWinHttpProxy(config.windows)
    await guard.switchMode({ mode: originalName, target, config, paths })
    console.log('强制复原完成')
  } catch (restoreError) {
    console.error('强制复原失败：', restoreError)
  }
}

process.exit(exitCode)
