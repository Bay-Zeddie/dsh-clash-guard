/**
 * 系统级看门狗入口（由 Windows 计划任务在登录时拉起，独立于 DSH 进程）。
 *
 * 循环做一件事：每隔 intervalMs 体检一次网络，发现「DNS 指向死隧道地址」
 * 或「系统代理指向死端口」就自动修复 —— 与插件内 selfheal.watchdog 完全
 * 同一套判定与修复逻辑（直接复用 lib/selfheal.js，不复制实现）。
 *
 * 退出协议：packageRoot()/bin/hostwatch.stop 文件存在即退出（卸载时由
 * uninstallHostWatch 写入）。进程用 unref 定时器，任务里的 Node 进程
 * 由计划任务管理生命周期，本身不残留。
 *
 * 跑法（由计划任务执行，手动调试也可以）：
 *   node bin/hostwatch.mjs --interval 15000
 */
import process from 'node:process'
import { existsSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { loadConfig } from '../lib/settings.js'
import { stateDir } from '../lib/paths.js'
import { startWatchdog } from '../lib/selfheal.js'

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const stopFile = path.join(packageRoot, 'bin', 'hostwatch.stop')

const args = process.argv.slice(2)
const intervalArg = args.indexOf('--interval')
const intervalMs = intervalArg >= 0 ? Number(args[intervalArg + 1]) || 15000 : 15000

const { config } = loadConfig()
// 登记簿文件挂在插件状态目录（与 DSH 内看门狗共用一份跨重启记忆）
const watchdogConfig = { ...config, selfheal: { ...config.selfheal, stateDir: stateDir() } }

const log = (message) => {
  const line = `[${new Date().toISOString()}] ${message}`
  try { console.log(line) } catch { /* 无控制台也继续 */ }
}

log(`hostwatch 启动：interval=${intervalMs}ms, packageRoot=${packageRoot}`)
const watchdog = startWatchdog({ config: watchdogConfig, log })

// stop 协议轮询：文件出现即优雅退出
const stopPoll = setInterval(() => {
  if (!existsSync(stopFile)) return
  log('收到 stop 信号，退出')
  watchdog.stop()
  try { rmSync(stopFile, { force: true }) } catch { /* ignore */ }
  process.exit(0)
}, 2000)
if (typeof stopPoll.unref === 'function') stopPoll.unref()

// 进程常驻（计划任务负责在注销时回收它）
setInterval(() => { /* keepalive，逻辑都在 watchdog 的定时器里 */ }, 1 << 30)
