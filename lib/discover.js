/**
 * 控制器发现 —— 零硬编码的核心。
 *
 * Clash Verge Rev 默认把 `external-controller` 置空，只在
 * `external-controller-pipe` 里留一条命名管道。**关键事实**：配置里记的管道名
 * 可能是陈旧的（应用重写配置后内核仍跑着旧管道，或反过来）。所以发现分两步：
 *
 *   1. 收集候选（显式配置 / 进程命令行 / 管道枚举 / 配置文件），按可信度排序；
 *   2. **实际连一下** `/version`，第一个应答的就是真命中的那个。
 *
 * 代码里没有一条字面量：名字模式来自 defaults.discovery，端口来自配置或设置。
 *
 * @module dsh-clash-guard/discover
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  appConfigCandidates,
  appDataCandidates,
  runtimeDirCandidates,
  serviceDirCandidates,
} from './paths.js'
import { probe } from './mihomo.js'

const run = promisify(execFile)

/** 读文本，失败返回 ''。
 *
 * **必须规范化 CRLF**：Clash Verge 在 Windows 上写的是 CRLF，而 `topScalar`
 * 的 `^key:\s*(.*)$` 里 `$` 前面会残留 `\r`，导致读到的值尾部带回车
 * （比较 `secret === ''`、`mode === 'global'` 全部失配）。统一成 LF。
 */
function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  } catch {
    return ''
  }
}

/**
 * 从 YAML 文本里取顶层标量。
 * 只认行首无缩进的 `key: value`，去引号，忽略注释。
 * @param {string} text
 * @param {string} key
 */
export function topScalar(text, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`^${escaped}\\s*:\\s*(.*)$`, 'm')
  const m = re.exec(text)
  if (m === null) return ''
  let value = m[1].trim()
  const hash = value.indexOf(' #')
  if (hash >= 0) value = value.slice(0, hash).trim()
  if (
    (value.startsWith("'") && value.endsWith("'"))
    || (value.startsWith('"') && value.endsWith('"'))
  ) {
    value = value.slice(1, -1)
  }
  return value
}

/** 把 `\\.\pipe\name` 规范成 `name`。 */
export function barePipeName(raw) {
  const value = String(raw ?? '').trim()
  if (value === '') return ''
  const idx = value.toLowerCase().lastIndexOf('pipe\\')
  if (idx >= 0) return value.slice(idx + 5).replace(/^\\+/, '')
  return value.replace(/^\\+/, '')
}

/** 从命令行抓 `-ext-ctl-pipe` 后面的管道名。 */
export function pipeFromCommandLine(commandLine) {
  if (typeof commandLine !== 'string' || commandLine === '') return ''
  const m = /-ext-ctl-pipe\s+(?:"([^"]+)"|(\S+))/i.exec(commandLine)
  if (m === null) return ''
  return barePipeName(m[1] ?? m[2] ?? '')
}

/** 从命令行抓 `-d` 指定的运行目录。 */
export function runtimeFromCommandLine(commandLine) {
  if (typeof commandLine !== 'string' || commandLine === '') return ''
  const m = /(?:^|\s)-d\s+(?:"([^"]+)"|(\S+))/i.exec(commandLine)
  return m === null ? '' : (m[1] ?? m[2] ?? '')
}

/** 从命令行抓可执行文件名（小写，含 .exe）。 */
export function exeFromCommandLine(commandLine) {
  if (typeof commandLine !== 'string') return ''
  const m = /(?:"([^"]+\.exe)"|(\S+\.exe))/i.exec(commandLine)
  if (m === null) return ''
  return path.basename(m[1] ?? m[2] ?? '').toLowerCase()
}

/**
 * 枚举 `\\.\pipe\` 下的管道名。
 * @param {string[]} prefixes 允许的前缀（小写比较）
 * @returns {string[]}
 */
export function enumeratePipes(prefixes) {
  const wanted = prefixes.map(p => p.toLowerCase())
  let names = []
  try {
    names = fs.readdirSync('\\\\.\\pipe\\')
  } catch {
    return []
  }
  return names.filter((name) => {
    const lower = name.toLowerCase()
    return wanted.some(p => lower.startsWith(p))
  })
}

/**
 * 查询内核进程命令行。
 * @param {string[]} coreNames 内核可执行文件名（不含 .exe，小写）
 * @param {number} timeoutMs
 * @param {string} powershell
 * @param {string[]} flags
 * @returns {Promise<string[]>} 命中的命令行
 */
export async function queryCoreCommandLines(coreNames, timeoutMs, powershell, flags) {
  const wanted = coreNames.map(n => `${n.toLowerCase()}.exe`)
  const script = 'Get-CimInstance Win32_Process | Select-Object Name,CommandLine | ForEach-Object {'
    + ' "$($_.Name)`t$($_.CommandLine)" }'
  try {
    const { stdout } = await run(powershell, [...flags, script], {
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    })
    const hits = []
    for (const line of stdout.split(/\r?\n/)) {
      const tab = line.indexOf('\t')
      if (tab < 0) continue
      const name = line.slice(0, tab).trim().toLowerCase()
      const cmd = line.slice(tab + 1).trim()
      if (wanted.includes(name) && cmd !== '') hits.push(cmd)
    }
    return hits
  } catch {
    return []
  }
}

/** 把一个候选压成可比较的键，用于去重。 */
function candidateKey(candidate) {
  return candidate.transport === 'pipe'
    ? `pipe:${candidate.pipe}`
    : `tcp:${candidate.host}:${candidate.port}`
}

/**
 * 收集全部候选，按可信度排序：
 *   1. 设置里显式指定的
 *   2. 内核进程命令行（运行中内核的真相）
 *   3. 管道枚举（当前活着的管道）
 *   4. 配置文件（可能是陈旧值）
 *
 * @param {object} options
 * @param {object} options.settings 完整配置
 * @param {object} options.defaults defaults.json
 * @returns {Promise<object>} 发现结果
 */
export async function discover(options) {
  const { settings, defaults } = options
  const discovery = defaults.discovery
  const controller = settings.controller ?? {}
  const winCfg = defaults.windows

  const appDirs = appDataCandidates(discovery)
  const serviceDirs = serviceDirCandidates(discovery)
  const runtimeDirs = runtimeDirCandidates(serviceDirs, discovery)
  const appConfigFiles = appConfigCandidates(appDirs, discovery.configFileNames)

  const candidates = []
  const seen = new Set()
  const push = (candidate) => {
    if (candidate.transport === 'pipe' && candidate.pipe === '') return
    if (candidate.transport === 'tcp' && candidate.port <= 0) return
    const key = candidateKey(candidate)
    if (seen.has(key)) return
    seen.add(key)
    candidates.push(candidate)
  }

  // 1. 设置显式指定
  const settingsPipe = barePipeName(controller.pipeName)
  const defaultHost = String(controller.defaultHost ?? '')
  if (settingsPipe !== '') {
    push({ transport: 'pipe', pipe: settingsPipe, host: '', port: 0, secret: String(controller.secret ?? ''), source: 'settings:pipeName' })
  }
  const settingsUrl = String(controller.controllerUrl ?? '').trim()
  if (settingsUrl !== '') {
    const m = /^(.*):(\d+)$/.exec(settingsUrl)
    if (m !== null) {
      push({ transport: 'tcp', pipe: '', host: m[1].trim() || defaultHost, port: Number(m[2]), secret: String(controller.secret ?? ''), source: 'settings:controllerUrl' })
    }
  }

  // 2. 进程命令行（运行中内核的真相）
  const coreCommandLines = await queryCoreCommandLines(
    discovery.coreNames,
    discovery.processQueryTimeoutMs,
    winCfg.powershell,
    winCfg.powershellFlags,
  )
  let secretFromProcess = ''
  for (const cmd of coreCommandLines) {
    const pipeName = pipeFromCommandLine(cmd)
    if (pipeName === '') continue
    if (secretFromProcess === '') {
      const runtime = runtimeFromCommandLine(cmd)
      if (runtime !== '') {
        secretFromProcess = topScalar(readText(path.join(runtime, discovery.runtimeConfigName)), 'secret')
      }
    }
    push({ transport: 'pipe', pipe: pipeName, host: '', port: 0, secret: String(controller.secret ?? '') || secretFromProcess, source: 'process:command-line' })
  }

  // 3. 管道枚举（活着的管道）
  for (const pipeName of enumeratePipes(discovery.pipePrefixes)) {
    push({ transport: 'pipe', pipe: pipeName, host: '', port: 0, secret: String(controller.secret ?? '') || secretFromProcess, source: 'pipe:enumeration' })
  }

  // 4. 配置文件（可能是陈旧值，放最后）
  const runtimeConfigs = runtimeDirs.map(dir => path.join(dir, discovery.runtimeConfigName))
  const configTexts = [...runtimeConfigs, ...appConfigFiles].map(file => ({ file, text: readText(file) }))

  let secretFromConfig = ''
  for (const { text } of configTexts) {
    const value = topScalar(text, 'secret')
    if (value !== '' && secretFromConfig === '') secretFromConfig = value
  }
  const effectiveSecret = String(controller.secret ?? '') || secretFromProcess || secretFromConfig

  for (const { file, text } of configTexts) {
    const pipeName = barePipeName(topScalar(text, 'external-controller-pipe'))
    if (pipeName !== '') {
      push({ transport: 'pipe', pipe: pipeName, host: '', port: 0, secret: effectiveSecret, source: `config:${path.basename(file)}` })
    }
  }
  for (const { file, text } of configTexts) {
    const value = topScalar(text, 'external-controller')
    if (value === '') continue
    const m = /^(.*):(\d+)$/.exec(value)
    if (m !== null) {
      push({ transport: 'tcp', pipe: '', host: m[1].trim() || defaultHost, port: Number(m[2]), secret: effectiveSecret, source: `config:${path.basename(file)}:tcp` })
    }
  }

  // 端口：设置 > 运行配置 > 应用配置
  let mixedPort = Number(settings.ports?.mixedPort ?? 0)
  let mixedPortSource = 'settings:ports.mixedPort'
  if (!Number.isFinite(mixedPort) || mixedPort <= 0) {
    mixedPort = 0
    for (const { file, text } of configTexts) {
      const value = Number(topScalar(text, 'mixed-port'))
      if (Number.isFinite(value) && value > 0) {
        mixedPort = value
        mixedPortSource = `config:${path.basename(file)}:mixed-port`
        break
      }
    }
  }
  if (mixedPort <= 0) {
    mixedPort = Number(settings.ports?.fallbackMixedPort ?? 0)
    mixedPortSource = 'settings:ports.fallbackMixedPort'
  }

  return {
    candidates,
    mixedPort,
    mixedPortSource,
    secret: effectiveSecret,
    appDirs,
    serviceDirs,
    runtimeDirs,
    appConfigFiles,
    runtimeConfigFiles: runtimeConfigs,
    coreCommandLines,
    requestTimeoutMs: Number(controller.requestTimeoutMs ?? 0) || undefined,
    serviceControl: readServiceControl(serviceDirs, discovery, appDirs),
  }
}

/**
 * 读服务的控制面：内核该不该跑、内核可执行在哪、用户的 owner key。
 *
 * **这不是「让插件依赖 GUI」** —— 它是插件**摆脱** GUI 的手段。
 * 内核由 Windows 服务守护（`clash_verge_service`，开机自启），GUI 只是个
 * 前端；服务读 `desired-state.json` 决定 `core_should_be_running`。
 * 拿到这份信息，插件就能在不打开 GUI 的情况下启动、停止、重启内核。
 *
 * @param {string[]} serviceDirs
 * @param {object} discovery defaults.discovery
 * @param {string[]} appDirs
 * @returns {object|null}
 */
export function readServiceControl(serviceDirs, discovery, appDirs) {
  for (const serviceDir of serviceDirs) {
    const usersDir = path.join(serviceDir, discovery.runtimeUsersDir)
    let owners = []
    try {
      owners = fs.readdirSync(usersDir, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
    } catch {
      continue
    }
    for (const owner of owners) {
      const ownerDir = path.join(usersDir, owner)
      const desiredFile = path.join(ownerDir, discovery.desiredStateFileName)
      const runtimeDir = path.join(ownerDir, discovery.runtimeSubdir)
      const configFile = path.join(runtimeDir, discovery.runtimeConfigName)
      if (!fs.existsSync(desiredFile)) continue

      let desired = {}
      try {
        desired = JSON.parse(readText(desiredFile))
      } catch {
        desired = {}
      }
      const coreConfig = desired.last_clash_config?.core_config ?? {}

      /**
       * **管道名以配置文件为准，不以 desired-state 为准。**
       *
       * 真机踩到的坑：desired-state 里记的是
       * `verge-mihomo-production-<hash>`，而 config.yaml 里写的是
       * `verge-mihomo-sidecar-release-<hash>` —— 两者漂移了。
       * 内核启动时读的是 config.yaml，所以它只会监听 sidecar 那个名字；
       * 如果插件只信 desired-state，就会永远连不上，还查不出原因。
       *
       * 所以这里优先从 config.yaml 里抠 `external-controller-pipe`，
       * 抠不到才退回 desired-state 的值，并把差异标出来。
       */
      const fromDesired = String(coreConfig.core_ipc_path ?? '')
      const fromConfig = pipeFromConfigFile(configFile)
      const ipcPath = fromConfig !== '' ? fromConfig : fromDesired

      return {
        owner,
        serviceDir,
        ownerDir,
        desiredFile,
        runtimeDir,
        configFile,
        coreShouldBeRunning: desired.core_should_be_running === true,
        generation: Number(desired.generation ?? 0),
        corePath: String(coreConfig.core_path ?? '').replace(/^\\\\\?\\/, ''),
        ipcPath,
        ipcPathFromConfig: fromConfig,
        ipcPathFromDesired: fromDesired,
        ipcPathMismatch: fromConfig !== '' && fromDesired !== '' && fromConfig !== fromDesired,
        configPath: String(coreConfig.config_path ?? ''),
        appDataRoot: String(readAppOwner(appDirs) ?? ''),
      }
    }
  }
  return null
}

/**
 * 从运行配置文件里读 `external-controller-pipe`。
 *
 * 这是**内核实际会用的管道名** —— 它启动时读的就是这份文件。
 *
 * @param {string} configFile
 * @returns {string} 管道名，读不到返回空串
 */
function pipeFromConfigFile(configFile) {
  const text = readText(configFile)
  if (text === '') return ''
  const match = /^external-controller-pipe:\s*['"]?(.+?)['"]?\s*$/m.exec(text)
  if (match === null) return ''
  const raw = match[1].trim()
  // 写成裸名字（不带 \\.\pipe\）时补全成完整路径
  if (raw === '' || raw === "''" || raw === '""') return ''
  if (raw.startsWith('\\\\.\\pipe\\')) return raw
  if (raw.includes('\\')) return raw
  return `\\\\.\\pipe\\${raw}`
}

/** 从应用数据目录里读出 `active-owner.json` 记录的 app_data_root。 */
function readAppOwner(appDirs) {
  for (const dir of appDirs) {
    const text = readText(path.join(dir, '.clash-verge-service-owner-token'))
    if (text !== '') return dir
  }
  return null
}

/**
 * 逐个探测候选，返回第一个真正应答的。
 *
 * 这是整套发现的收口：配置里写的是什么不重要，**能应答的才是真的**。
 *
 * @param {object} discovered discover() 的返回值
 * @returns {Promise<object>} 带 `transport/pipe/host/port/secret` 的目标 + 探测轨迹
 */
export async function pickWorking(discovered) {
  const attempts = []
  for (const candidate of discovered.candidates) {
    const target = {
      ...candidate,
      mixedPort: discovered.mixedPort,
      requestTimeoutMs: discovered.requestTimeoutMs,
    }
    const result = await probe(target)
    attempts.push({ source: candidate.source, transport: candidate.transport, ok: result.ok, version: result.version, error: result.error })
    if (result.ok) {
      return { target, attempts, reachable: true }
    }
  }
  return { target: null, attempts, reachable: false }
}

/**
 * 一步到位：发现 + 探测，返回可用的 target。
 * @param {object} options {settings, defaults}
 */
export async function resolve(options) {
  const discovered = await discover(options)
  const picked = await pickWorking(discovered)
  if (picked.reachable !== true) {
    return { ok: false, discovered, target: null, attempts: picked.attempts }
  }
  const stored = readStoredMode(discovered.appConfigFiles)
  return {
    ok: true,
    discovered,
    attempts: picked.attempts,
    target: {
      ...picked.target,
      modeFile: stored === null ? '' : stored.file,
      storedMode: stored === null ? '' : stored.mode,
    },
  }
}

/**
 * 读配置文件里当前持久化的 mode。
 * @param {string[]} appConfigFiles
 * @returns {{file: string, mode: string}|null}
 */
export function readStoredMode(appConfigFiles) {
  for (const file of appConfigFiles) {
    const mode = topScalar(readText(file), 'mode')
    if (mode !== '') return { file, mode }
  }
  return null
}

/** 供诊断：把候选列表压成一行。 */
export function describeCandidates(discovered) {
  return discovered.candidates.map((c) => {
    const where = c.transport === 'pipe' ? `pipe:${c.pipe.slice(0, 18)}…` : `tcp:${c.host}:${c.port}`
    return `${where} (${c.source})`
  })
}

export { readText }
