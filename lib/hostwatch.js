/**
 * 系统级看门狗 —— DSH 没开时也盯着「Clash 死了 DNS 残留」。
 *
 * ## 为什么要有这一层
 *
 * 插件内的看门狗（selfheal.startWatchdog）跑在 DSH 宿主进程里，DSH 一关
 * 它就停了。而事故恰恰发生在「用完 Clash 关掉一切」之后 —— 那时插件内
 * 的守护不在场。唯一可靠的兜底是系统级的东西。
 *
 * ## 设计纪律（零依赖、可迁移、可卸载）
 *
 * 1. **只用 Windows 自带的 schtasks**：不装服务、不写注册表 Run 键、
 *    不需要第三方。任务在用户登录时启动一个 Node 进程跑本插件的
 *    `bin/hostwatch.mjs`，循环体检；用户注销时进程随之结束（任务触发器
 *    是 AtLogOn，且进程自身不残留）。
 * 2. **任务名固定**（defaults.selfheal.hostWatchTaskName）：安装幂等
 *    （已存在则先删再建），卸载按名字精确删除，绝不碰用户自己的任务。
 * 3. **命令行零硬编码**：Node 路径用 process.execPath，脚本路径用
 *    packageRoot() 推导，全部来自运行时环境 —— 换机器、换 Node 都对。
 * 4. **杀进程窗口**：hostwatch.mjs 自己带 stop 文件协议 —— 卸载任务前
 *    写 stop 文件，循环看到就退出，不会留下孤儿进程。
 *
 * @module dsh-clash-guard/hostwatch
 */
import fs from 'node:fs'
import path from 'node:path'
import { shell } from './windows.js'
import { packageRoot } from './paths.js'

/**
 * 计划任务是否已注册。
 * @param {object} cfg defaults.windows
 * @param {string} taskName
 */
export async function hostWatchStatus(cfg, taskName) {
  const script = `schtasks /query /tn '${taskName}' 2>$null | Select-String -Pattern '${taskName}' | Measure-Object | ForEach-Object { $_.Count }`
  const res = await shell(cfg, script)
  const count = Number(String(res.stdout ?? '').trim())
  return { installed: Number.isFinite(count) && count > 0 }
}

/**
 * 安装系统级看门狗计划任务。
 *
 * 命令形如：`<node.exe> <packageRoot>/bin/hostwatch.mjs --interval <ms>`。
 * 用 `/sc onlogon` 触发器（登录即起，覆盖开机自启的场景）；highest 权限
 * 让它能改 DNS（Set-DnsClientServerAddress 需要管理员）。
 *
 * @param {object} options
 * @param {object} options.cfg defaults.windows
 * @param {object} options.selfheal defaults.selfheal（taskName / interval）
 * @param {string} options.nodePath process.execPath
 * @returns {Promise<{ok: boolean, detail: string}>}
 */
export async function installHostWatch(options) {
  const { cfg, selfheal, nodePath } = options
  const taskName = selfheal.hostWatchTaskName
  const interval = Number(selfheal.hostWatchIntervalMs ?? 0) || 15000
  const script = path.join(packageRoot(), 'bin', 'hostwatch.mjs')
  if (!fs.existsSync(script)) {
    return { ok: false, detail: `找不到看门狗脚本：${script}` }
  }

  const args = '"' + script + '" --interval ' + interval
  const createScript = [
    "$ErrorActionPreference = 'Stop'",
    "$Action = New-ScheduledTaskAction -Execute '" + nodePath.replace(/'/g, "''") + "' -Argument '" + args.replace(/'/g, "''") + "'",
    "$Trigger = New-ScheduledTaskTrigger -AtLogOn",
    "$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)",
    "$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Highest",
    "Register-ScheduledTask -TaskName '" + taskName.replace(/'/g, "''") + "' -Action $Action -Trigger $Trigger -Settings $Settings -Principal $Principal -Force | Out-Null",
    "Write-Output 'ok'",
  ].join('\n')
  const create = await shell(cfg, createScript)
  const out = String(create?.stdout ?? '')
  if (!create.ok || !out.includes('ok')) {
    return { ok: false, detail: (create?.stderr || out || 'needs elevation').slice(0, 300) }
  }
  const verify = await hostWatchStatus(cfg, taskName)
  return verify.installed
    ? { ok: true, detail: `已注册计划任务 ${taskName}（登录自启，间隔 ${interval}ms）` }
    : { ok: false, detail: '注册命令成功但查询不到任务 —— 请检查权限' }
}

/**
 * 卸载系统级看门狗：写 stop 文件让循环退出，再删任务。
 * @param {object} options
 * @param {object} options.cfg defaults.windows
 * @param {object} options.selfheal defaults.selfheal
 * @returns {Promise<{ok: boolean, detail: string}>}
 */
export async function uninstallHostWatch(options) {
  const { cfg, selfheal } = options
  const taskName = selfheal.hostWatchTaskName
  // 先通知循环退出（stop 文件协议），再删任务
  const stopFile = path.join(packageRoot(), 'bin', 'hostwatch.stop')
  try { fs.writeFileSync(stopFile, String(Date.now()), 'utf8') } catch { /* 尽力而为 */ }
  const del = await shell(cfg, `schtasks /delete /tn '${taskName}' /f 2>$null; Write-Output 'done'`)
  const ok = del.ok && String(del.stdout ?? '').includes('done')
  // stop 文件是「一次性信号」，删掉让下次安装干净
  try { fs.rmSync(stopFile, { force: true }) } catch { /* ignore */ }
  const verify = await hostWatchStatus(cfg, taskName)
  if (verify.installed) return { ok: false, detail: '删除命令已发但任务仍在 —— 请检查权限' }
  return { ok: true, detail: ok ? `已卸载 ${taskName} 并通知看门狗进程退出` : `任务本就不存在（视为已卸载）` }
}
