/**
 * 内核生命周期控制 —— 让插件**摆脱 GUI**。
 *
 * 实测事实（本机 v1.19.33 + clash-verge-service）：
 *
 *   · 内核 `verge-mihomo.exe` 的父进程是 **Windows 服务** `clash_verge_service`
 *     （开机自启），不是 GUI 进程；
 *   · 杀掉内核，服务 5 秒内自动拉起（守护生效）；
 *   · 关掉 GUI（`clash-verge.exe`），内核与命名管道照常存活、照常可控制；
 *   · 服务读 `users/<owner>/desired-state.json` 的 `core_should_be_running`
 *     决定该不该有内核；内核配置取 `users/<owner>/runtime/config.yaml`。
 *
 * 所以「插件要不要依赖快捷方式」的答案是**不要**。本模块给出三条独立路径：
 *
 *   1. `kernelState()`      —— 只读：内核在不在、服务在不在、谁在守护；
 *   2. `startKernel()`      —— 服务在跑但内核没起时，置 desired + 等管道；
 *   3. `restartKernel()`    —— 改了配置文件后让内核重新读取（服务会自己拉起）。
 *
 * 全部经过 `defaults.core`，代码里没有字面量。
 *
 * @module dsh-clash-guard/core
 */
import fs from 'node:fs'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { probe } from './mihomo.js'

const run = promisify(execFile)

/** 等一个条件成立，超时返回 false。 */
async function waitFor(check, timeoutMs, intervalMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await check()) return true
    if (Date.now() >= deadline) return false
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
}

/** 跑一段 PowerShell，返回 stdout（失败返回 ''）。 */
async function shell(cfg, script, timeoutMs) {
  try {
    const { stdout } = await run(cfg.powershell, [...cfg.powershellFlags, script], {
      windowsHide: true,
      timeout: timeoutMs ?? cfg.commandTimeoutMs,
      maxBuffer: cfg.maxBufferBytes,
    })
    return stdout
  } catch {
    return ''
  }
}

/**
 * 查进程是否在跑。
 * @param {object} cfg defaults.windows
 * @param {string[]} names 进程名（不含 .exe）
 * @returns {Promise<Array<{id: number, name: string}>>}
 */
async function processesNamed(cfg, names) {
  const list = names.map(n => `'${n.toLowerCase()}.exe'`).join(',')
  const script = `Get-Process -ErrorAction SilentlyContinue | Where-Object { ${list} -contains $_.Name.ToLower() + '.exe' } | ForEach-Object { '{0}|{1}' -f $_.Id, $_.Name }`
  const out = await shell(cfg, script)
  return out.split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id, name] = line.split('|')
      return { id: Number(id) || 0, name: String(name ?? '') }
    })
}

/**
 * 查 Windows 服务状态。
 * @param {object} cfg defaults.windows
 * @param {string} serviceName
 * @returns {Promise<{exists: boolean, running: boolean, startMode: string}>}
 */
async function serviceState(cfg, serviceName) {
  const script = `$s = Get-Service -Name '${serviceName}' -ErrorAction SilentlyContinue; if ($s) { '{0}|{1}' -f $s.Status, $s.StartType } else { 'missing|' }`
  const out = (await shell(cfg, script)).trim()
  const [status, startMode] = out.split('|')
  return {
    exists: status !== 'missing' && status !== '',
    running: String(status).toLowerCase() === 'running',
    startMode: String(startMode ?? ''),
  }
}

/**
 * 读内核/服务的当前状态。
 *
 * @param {object} options
 * @param {object} options.config 完整配置
 * @param {object} options.discovered discover() 的返回值
 * @param {object} [options.target] 已解析的控制器目标（有就顺带探一下存活）
 * @returns {Promise<object>}
 */
export async function kernelState(options) {
  const { config, discovered, target } = options
  const core = config.core
  const winCfg = config.windows

  const cores = await processesNamed(winCfg, core.coreProcessNames)
  const guis = await processesNamed(winCfg, core.guiProcessNames)
  const service = await serviceState(winCfg, core.serviceName)

  let controllerAlive = false
  let version = ''
  if (target !== undefined && target !== null) {
    const result = await probe(target)
    controllerAlive = result.ok === true
    version = result.version ?? ''
  }

  const control = discovered.serviceControl ?? null
  return {
    /** 内核进程 */
    coreRunning: cores.length > 0,
    corePids: cores.map(entry => entry.id),
    /** GUI 进程（只是前端，不影响控制） */
    guiRunning: guis.length > 0,
    guiPids: guis.map(entry => entry.id),
    /** Windows 服务 */
    serviceExists: service.exists,
    serviceRunning: service.running,
    serviceStartMode: service.startMode,
    /** 控制器（管道/端口）是否应答 */
    controllerAlive,
    version,
    /** 服务侧的期望状态 */
    desiredCoreShouldRun: control === null ? null : control.coreShouldBeRunning,
    /** 能不能由插件拉起：服务在跑 + 知道 desired-state 在哪 */
    canStartByService: service.running && control !== null,
    serviceControl: control,
    /** 中文一句话结论 */
    summary: describeKernel({
      coreRunning: cores.length > 0,
      guiRunning: guis.length > 0,
      serviceRunning: service.running,
      controllerAlive,
    }),
  }
}

/** 把内核状态压成一句话。 */
function describeKernel(state) {
  if (!state.serviceRunning && !state.coreRunning) {
    return '服务与内核都没起：需要先启动 clash_verge_service（或打开一次 Clash Verge）'
  }
  if (state.coreRunning && state.controllerAlive) {
    return state.guiRunning
      ? '内核在跑，控制器可达（GUI 也在）'
      : '内核在跑，控制器可达，GUI 未启动 —— 插件可独立控制'
  }
  if (state.coreRunning && !state.controllerAlive) {
    return '内核进程在，但控制器不应答：可能正在启动，或管道名变了'
  }
  return '服务在跑但内核没起：插件可通过服务拉起'
}

/**
 * 等控制器可达 —— **每次都重新发现**。
 *
 * 这是关键：启动前解析出来的 target 可能指向一个还不存在的管道（内核没起时
 * 进程命令行里没有管道名，`discover` 会回退到配置文件里的陈旧值）。内核起来
 * 之后管道名才出现，所以轮询必须重新走一遍发现流程，而不是复用旧 target。
 *
 * @param {object} options
 * @param {object} options.config
 * @param {(discovered: object) => Promise<object>} options.refresh 重新发现 + 探测
 * @returns {Promise<{ok: boolean, target: object|null, version: string}>}
 */
async function awaitController(options) {
  const { config, refresh } = options
  const core = config.core
  const deadline = Date.now() + core.startTimeoutMs
  let last = { ok: false, target: null, version: '' }

  for (;;) {
    last = await refresh()
    if (last.ok) return last
    if (Date.now() >= deadline) return last
    await new Promise(resolve => setTimeout(resolve, core.pollIntervalMs))
  }
}

/**
 * 让内核起来。
 *
 * 两条路，按可用性选：
 *   1. **服务路**（首选）：置 `desired-state.json` 的 `core_should_be_running`
 *      为 true，服务自己拉起内核 —— 这是它守护逻辑的正常输入；
 *   2. **直启路**：服务不可用时，用 `desired-state.json` 里记下的
 *      `core_path` + `config_path` + `core_ipc_path` 直接 spawn 内核。
 *
 * @param {object} options
 * @param {object} options.config
 * @param {object} options.discovered
 * @param {object} [options.target]
 * @param {boolean} [options.force] 跳过「已经活着」的短路（重启路径用）
 * @param {() => Promise<{ok: boolean, target: object|null, version: string}>} [options.refresh]
 *   重新发现 + 探测的回调；不给就退化为「探测一次旧 target」。
 * @returns {Promise<{ok: boolean, method: string, detail: string, target?: object|null}>}
 */
export async function startKernel(options) {
  const { config, discovered } = options
  const core = config.core
  const control = discovered.serviceControl
  const force = options.force === true

  if (control === null) {
    return { ok: false, method: 'none', detail: '找不到服务的 desired-state.json，无法定位内核启动参数' }
  }

  /** 重新发现 + 探测；调用方没给回调就退化为探一次旧 target。 */
  const refresh = options.refresh ?? (async () => {
    const result = await probe(options.target ?? {})
    return { ok: result.ok === true, target: result.ok === true ? options.target : null, version: result.version ?? '' }
  })

  // 已经活着就别动（重启路径要跳过这一步：那时内核正在停）
  if (!force) {
    const now = await refresh()
    if (now.ok) {
      return { ok: true, method: 'already-running', detail: `控制器已可达（${now.version}）`, target: now.target }
    }
  }

  // 服务在不在跑 —— 每次都现查，不复用上面可能没取的变量
  const service = await serviceState(config.windows, core.serviceName)

  // ——— 服务路 ———
  if (service.running) {
    try {
      const raw = JSON.parse(fs.readFileSync(control.desiredFile, 'utf8'))
      raw.core_should_be_running = true
      raw.generation = Number(raw.generation ?? 0) + 1
      raw.updated_at = Math.floor(Date.now() / 1000)

      /**
       * **顺手把漂移的管道名对齐回配置。**
       *
       * 真机踩到过：desired-state 记 `…-production-…`，config.yaml 写
       * `…-sidecar-release-…`。内核读 config.yaml 起，所以它监听后者；
       * 服务按 desired-state 去探测前者，永远探不到，于是「服务在跑但
       * 内核起不来」。
       *
       * 这里不改配置（那是内核的真相），只把 desired-state 改成和配置一致，
       * 让服务下次探测能对上。
       */
      if (control.ipcPathMismatch === true && control.ipcPathFromConfig !== '') {
        const coreConfig = raw.last_clash_config?.core_config
        if (coreConfig !== undefined && coreConfig !== null) {
          coreConfig.core_ipc_path = control.ipcPathFromConfig
        }
      }

      fs.writeFileSync(control.desiredFile, `${JSON.stringify(raw, null, 2)}\n`, 'utf8')
    } catch (error) {
      return { ok: false, method: 'service', detail: `写入 desired-state 失败：${error.message}` }
    }

    // 服务会自己拉起；等控制器应答（每次都重新发现，管道名是起来后才有的）
    const picked = await awaitController({ config, refresh })
    if (picked.ok) {
      return { ok: true, method: 'service', detail: '服务已按期望状态拉起内核，控制器可达', target: picked.target }
    }
    return { ok: false, method: 'service', detail: `已请求服务拉起，但 ${core.startTimeoutMs}ms 内控制器仍不可达`, target: null }
  }

  // ——— 直启路 ———
  //
  // ## ⚠️ 这条路是「最后手段」，默认关闭
  //
  // **真机事故（2026-11-18 23:00）**：插件用 `spawn(detached)` 手工拉起内核
  // （PID 11480），用户随后从 Clash Verge UI 退出时，那个孤儿进程没死透。
  // 再启动 Clash 时，服务发现「已有一个 core 在跑」，直接拒绝：
  //
  //     Failed to start owner core:
  //     process verge-mihomo.exe (PID 11480) is still running; refusing a second core
  //
  // 结果：服务把 WLAN 的 DNS 改回 `198.18.0.2`（TUN 准备工作），
  // 但内核始终没起来 —— DNS 指向一个没人听的地址，**整机解析全死**。
  // 用户连不上网，只能手动重置 DNS 才恢复。
  //
  // 教训：**内核是服务的孩子，不能由插件收养**。
  // 直启只在「服务根本不存在」时才有意义，且必须：
  //   1. 有显式开关（`core.allowDirectSpawn`，默认 false）；
  //   2. 启动前确认没有残留内核（否则就是制造孤儿）；
  //   3. 拉起失败时把自己 spawn 的进程杀掉，绝不留尸体。
  if (core.allowDirectSpawn !== true) {
    return {
      ok: false,
      method: 'refused',
      detail: '服务在跑但内核起不来，且直启被禁用（避免留下孤儿进程堵死 Clash）。'
        + '请用 Clash Verge 界面启动，或排查服务日志里是否有「refusing a second core」。',
      target: null,
    }
  }

  if (control.corePath === '' || control.configPath === '') {
    return { ok: false, method: 'spawn', detail: 'desired-state 里没有 core_path / config_path，无法直启', target: null }
  }
  if (!fs.existsSync(control.corePath)) {
    return { ok: false, method: 'spawn', detail: `内核不存在：${control.corePath}`, target: null }
  }

  // 直启前必须确认没有残留内核 —— 否则就是在制造下一个孤儿
  const existing = await processesNamed(config.windows, core.coreProcessNames)
  if (existing.length > 0) {
    return {
      ok: false,
      method: 'spawn',
      detail: `已有内核在跑（PID ${existing.join(', ')}），拒绝再起一个 —— 那会让 Clash 之后无法启动`,
      target: null,
    }
  }

  const args = ['-d', control.runtimeDir, '-f', control.configPath]
  if (control.ipcPath !== '') args.push('-ext-ctl-pipe', control.ipcPath)

  let childPid = 0
  try {
    // **不 detach**：detach 会让内核脱离父进程树，插件退出后它变成孤儿，
    // 而服务把它当成「未知的第二内核」拒绝启动。这是事故的直接成因。
    const child = spawn(control.corePath, args, {
      cwd: control.runtimeDir,
      detached: false,
      stdio: 'ignore',
      windowsHide: true,
    })
    childPid = child.pid ?? 0
    // 不让子进程的退出事件拖住宿主事件循环
    child.unref()
  } catch (error) {
    return { ok: false, method: 'spawn', detail: `启动失败：${error.message}`, target: null }
  }

  const picked = await awaitController({ config, refresh })
  if (picked.ok) {
    return { ok: true, method: 'spawn', detail: '已直接启动内核，控制器可达（注意：这是插件拉起的内核，Clash UI 退出时不会带走它）', target: picked.target }
  }

  // 起不来就把自己 spawn 的进程清掉，绝不留尸体
  if (childPid > 0) {
    try { process.kill(childPid) } catch { /* 可能已退出 */ }
  }
  return { ok: false, method: 'spawn', detail: `已 spawn 但 ${core.startTimeoutMs}ms 内控制器仍不可达，已清理该进程`, target: null }
}

/**
 * 重启内核：改了配置文件后让内核重新读取。
 *
 * 服务路：把 `core_should_be_running` 先置 false 再置 true，服务会先停再起。
 * 没有服务守护时退化为「杀进程 + 直启」。
 *
 * @param {object} options
 * @returns {Promise<{ok: boolean, method: string, detail: string}>}
 */
export async function restartKernel(options) {
  const { config, discovered } = options
  const core = config.core
  const control = discovered.serviceControl
  const before = await kernelState({ config, discovered, target: options.target })

  if (control !== null && before.serviceRunning) {
    try {
      const raw = JSON.parse(fs.readFileSync(control.desiredFile, 'utf8'))
      raw.core_should_be_running = false
      raw.generation = Number(raw.generation ?? 0) + 1
      raw.updated_at = Math.floor(Date.now() / 1000)
      fs.writeFileSync(control.desiredFile, `${JSON.stringify(raw, null, 2)}\n`, 'utf8')
    } catch (error) {
      return { ok: false, method: 'service', detail: `写入 desired-state(false) 失败：${error.message}` }
    }

    // 等服务把内核停掉
    await waitFor(async () => {
      const list = await processesNamed(config.windows, core.coreProcessNames)
      return list.length === 0
    }, core.stopTimeoutMs, core.pollIntervalMs)

    // 再让它起来 —— force 跳过「已经活着」的短路（此刻旧内核可能还没完全退干净）
    return startKernel({ ...options, force: true })
  }

  // 无服务守护：杀 + 拉
  for (const pid of before.corePids) {
    try {
      process.kill(pid)
    } catch {
      /* 可能已经退出 */
    }
  }
  await waitFor(async () => {
    const list = await processesNamed(config.windows, core.coreProcessNames)
    return list.length === 0
  }, core.stopTimeoutMs, core.pollIntervalMs)

  return startKernel({ ...options, force: true })
}

/**
 * 造一个「重新发现 + 探测」的回调，给 startKernel / restartKernel 用。
 *
 * 放在这里而不是让每个调用方自己拼，是因为**必须重新发现**这件事
 * 很容易漏（漏了就会出现「内核明明起来了却报不可达」）。
 *
 * @param {object} config
 * @param {(options: object) => Promise<object>} resolveFn discover.resolve
 * @returns {() => Promise<{ok: boolean, target: object|null, version: string}>}
 */
export function makeRefresher(config, resolveFn) {
  return async () => {
    const found = await resolveFn({ settings: config, defaults: config })
    if (found.ok !== true) return { ok: false, target: null, version: '' }
    return {
      ok: true,
      target: { ...found.target, runtimeDirs: found.discovered.runtimeDirs },
      version: found.attempts.find(attempt => attempt.ok === true)?.version ?? '',
    }
  }
}
