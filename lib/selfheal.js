/**
 * 网络自愈 —— 防止插件/Clash 把整机网络搞死。
 *
 * ## 这个模块解决的真实事故
 *
 * 2026-11-18 连续两次：Clash 非正常退出后，物理网卡的 DNS 停在
 * `198.18.0.2`（TUN 的 fake-ip 网关），而内核已经不在了 ——
 * 那个地址没人监听，**所有域名解析全部超时**，整机断网。
 *
 * 用户看到的是「Clash 把网络搞坏了」，实际是**残留状态没人清理**。
 *
 * 靠人记着「要正常退出」不管用（两次都复发），所以这里做三件事：
 *
 *   1. **自检**（{@link inspectNetwork}）：现在网络健康吗？有残留吗？
 *   2. **自愈**（{@link healNetwork}）：把残留还原成可用状态。
 *   3. **守护**（{@link startWatchdog}）：定时跑 1+2，命中就自动修。
 *
 * ## 安全边界
 *
 * 自愈只做「让网络恢复可用」这一件事：
 *   · DNS 指向死地址 → 重置成 DHCP 拿到的
 *   · 系统代理指向死端口 → 关掉
 *   · 绝不改 Clash 的配置，绝不杀内核
 *
 * @module dsh-clash-guard/selfheal
 */
import fs from 'node:fs'
import path from 'node:path'
import { shell, readDnsServers, readSystemProxy, clearSystemProxy, readIpv6State } from './windows.js'
import { kernelState } from './core.js'
import { readText } from './discover.js'
import { blockScalar } from './snapshot.js'

/**
 * 判断一个 DNS 地址是否属于「只有 TUN 在内核活着时才有效」的那类。
 *
 * fake-ip 段（`198.18.0.0/15`）是 mihomo 的默认，TUN 网卡自己的网关
 * 也是这个段。内核一死，这个地址就没人应答。
 *
 * @param {string} address
 * @param {string} fakeRange
 * @returns {boolean}
 */
export function isTunnelDns(address, fakeRange) {
  const ip = String(address ?? '').trim()
  if (ip === '') return false
  const [base, bitsRaw] = String(fakeRange).split('/')
  const bits = Number(bitsRaw)
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false

  const toInt = (value) => {
    const parts = String(value).split('.')
    if (parts.length !== 4) return null
    let out = 0
    for (const part of parts) {
      const n = Number(part)
      if (!Number.isInteger(n) || n < 0 || n > 255) return null
      out = (out * 256) + n
    }
    return out
  }
  const a = toInt(ip)
  const b = toInt(base)
  if (a === null || b === null) return false
  if (bits === 0) return true
  const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0
  return (a & mask) === (b & mask)
}

/**
 * 推导「这台机器的隧道 DNS 判定段」。
 *
 * **不能只信 defaults.leaks.fakeIpRange**。defaults 里是 mihomo 的出厂默认
 * `198.18.0.0/15`，但 Clash Verge 的订阅模板经常改写它 —— 真机实测本机的
 * runtime/config.yaml 写的是 `fake-ip-range: 28.0.0.1/8`。只按 defaults
 * 判定的话，看门狗在本机上**永远**认不出死隧道地址，静默失效。
 *
 * 正确做法：以内核实际在用的运行配置为准，defaults 只做兜底。两个段都参与
 * 判定 —— 配置可能刚被换过，物理网卡上残留的是换之前的段。
 *
 * 读不到运行配置（内核从未装过 / 服务目录不存在）时退回 defaults，
 * 退化为旧行为，不会误报。
 *
 * @param {object} config 完整插件配置
 * @param {object} [discovered] discover() 的返回值（有就用它的 runtimeDirs）
 * @returns {string[]} 参与判定的 CIDR 段
 */
export function tunnelDnsRanges(config, discovered) {
  const ranges = []
  const push = (value) => {
    const text = String(value ?? '').trim()
    if (text !== '' && !ranges.includes(text)) ranges.push(text)
  }
  push(config.leaks.fakeIpRange)
  const runtimeName = config.discovery.runtimeConfigName
  const dirs = Array.isArray(discovered?.runtimeDirs) && discovered.runtimeDirs.length > 0
    ? discovered.runtimeDirs
    // 自愈路径可能没有现成的 discovered（看门狗每 tick 都跑，发现太贵），
    // 退化到 paths.js 同款目录推导：服务目录 + runtime 子目录。
    : guessRuntimeDirs(config)
  for (const dir of dirs) {
    // fake-ip-range 是 dns: 块下的缩进键，topScalar 取不到，用块感知的 blockScalar
    const value = blockScalar(readText(path.join(dir, runtimeName)), 'dns', 'fake-ip-range')
    push(value)
  }
  return ranges
}

/**
 * 不跑 PowerShell 进程发现时的运行目录推导（纯文件系统，零开销）。
 * 与 paths.serviceDirCandidates 的判定一致，但只走目录存在性检查。
 * @param {object} config
 */
function guessRuntimeDirs(config) {
  const discovery = config.discovery
  const programData = String(process.env.ProgramData ?? '').trim()
  const local = path.join(process.env.USERPROFILE ?? '', 'AppData', 'Local')
  const parents = [programData, local].filter(p => p !== '')
  const servicePatterns = discovery.serviceDirPatterns.map(p => p.toLowerCase())
  const dirs = []
  for (const parent of parents) {
    let names = []
    try {
      names = fs.readdirSync(parent, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name)
    } catch {
      continue
    }
    for (const name of names) {
      if (!servicePatterns.some(p => name.toLowerCase().includes(p))) continue
      const usersDir = path.join(parent, name, discovery.runtimeUsersDir)
      let owners = []
      try {
        owners = fs.readdirSync(usersDir, { withFileTypes: true })
          .filter(e => e.isDirectory())
          .map(e => e.name)
      } catch {
        continue
      }
      for (const owner of owners) {
        const runtime = path.join(usersDir, owner, discovery.runtimeSubdir)
        if (fs.existsSync(path.join(runtime, discovery.runtimeConfigName))) dirs.push(runtime)
      }
    }
  }
  return dirs
}

/**
 * 「内核活着时亲眼看过的隧道 DNS 地址」登记簿。
 *
 * 网段判定（`28.0.0.1/8` 这类改写段）有误伤面：大段可能覆盖用户局域网。
 * 内核活着期间读到过的隧道地址才是确凿证据 —— 把它们记下来，内核死后
 * 只对这份清单报警。清单为空（首次安装、内核从未活着过）时退回网段判定，
 * 行为与旧版一致。
 *
 * 内存一份（进程内即时生效）+ 磁盘一份（DSH 重启后仍有效）。
 * 文件挂在插件自己的状态目录，不碰 Clash 的任何文件。
 */
const rememberedTunnel = { value: null, at: 0 }

function tunnelMemoryFile(config) {
  const stateDir = String(config.selfheal?.stateDir ?? '').trim()
  if (stateDir !== '') return path.join(stateDir, 'tunnel-dns.json')
  return null
}

/**
 * 记下内核活着期间看到的隧道地址。
 * @param {object} config
 * @param {string[]} addresses
 */
export function rememberTunnelAddresses(config, addresses) {
  const list = (Array.isArray(addresses) ? addresses : []).map(a => String(a).trim()).filter(Boolean)
  if (list.length === 0) return
  rememberedTunnel.value = list
  rememberedTunnel.at = Date.now()
  const file = tunnelMemoryFile(config)
  if (file === null) return
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${JSON.stringify({ addresses: list, updatedAt: Date.now() }, null, 2)}\n`, 'utf8')
  } catch {
    // 磁盘写失败只影响跨重启的记忆，不影响本次判定
  }
}

/**
 * 读已登记的隧道地址（内存优先，磁盘兜底）。
 * @param {object} config
 * @returns {string[]} 空数组 = 没有确凿记录
 */
export function readKnownTunnelAddresses(config) {
  if (rememberedTunnel.value !== null) return rememberedTunnel.value
  const file = tunnelMemoryFile(config)
  if (file === null) return []
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    const list = Array.isArray(data?.addresses)
      ? data.addresses.map(a => String(a).trim()).filter(Boolean)
      : []
    if (list.length > 0) {
      rememberedTunnel.value = list
      rememberedTunnel.at = Date.now()
    }
    return list
  } catch {
    return []
  }
}

/**
 * 体检：网络现在健康吗？有没有残留？
 *
 * 只读，不改任何东西。面板与工具都可以安全调用。
 *
 * @param {object} options
 * @param {object} options.config
 * @param {object} [options.discovered]
 * @returns {Promise<object>}
 */
export async function inspectNetwork(options) {
  const { config } = options
  const winCfg = config.windows
  // 隧道 DNS 判定段：内核运行配置里的 fake-ip-range 优先，defaults 兜底
  const fakeRanges = tunnelDnsRanges(config, options.discovered)

  // 内核在不在（用 core.kernelState 统一口径，避免两处各查一遍）
  const kernel = await kernelState({ config, discovered: options.discovered }).catch(() => null)
  const corePids = Array.isArray(kernel?.corePids) ? kernel.corePids : []
  const coreRunning = kernel?.coreRunning === true

  // 物理网卡的 DNS
  const dnsList = await readDnsServers(winCfg)
  const v6 = await readIpv6State(winCfg, config.discovery).catch(() => ({ physicalAdapter: '' }))
  const physical = dnsList.find(entry => entry.alias === v6.physicalAdapter) ?? dnsList[0] ?? null
  const dnsServers = Array.isArray(physical?.v4) ? physical.v4 : []
  const tunnelDns = dnsServers.filter(ip => fakeRanges.some(range => isTunnelDns(ip, range)))

  // 系统代理
  const proxy = await readSystemProxy(winCfg).catch(() => ({ enabled: false, server: '' }))

  /* —— 判定 —— */

  const problems = []

  /**
   * ① DNS 指向隧道地址，**且**内核没在跑 → 死地址，整机解析会挂。
   *
   * **两个条件缺一不可**：
   *   · 内核活着时，物理网卡 DNS 指向 `198.18.0.2` 是完全正常的 ——
   *     那正是 mihomo 的 TUN 网关，DNS 劫持要靠它。此时报警就是误报。
   *   · 内核死了之后，那个地址没人应答，才是真的断网。
   *
   * 第一次写这条时只看「是不是隧道地址」，结果内核正常运行也报红 ——
   * 那种误报会让用户学会忽略告警，比不报更糟。
   *
   * 第三道防误伤：订阅模板改写 fake-ip 段后（如 `28.0.0.1/8`），大段可能
   * 覆盖用户局域网的真实网关。只要那条 DNS 仍在被应答（内核活着）就说明
   * 它是活的隧道网关，不是残留 —— 报警条件已由 `!coreRunning` 兜住；
   * 这里再把「内核活着期间读到过的隧道地址」记进运行配置，让内核死后
   * 的判定只针对**真实存在过的隧道地址**，而不是猜测的网段。
   */
  if (tunnelDns.length > 0 && coreRunning) {
    rememberTunnelAddresses(config, tunnelDns)
  }
  const knownTunnel = readKnownTunnelAddresses(config)
  const deadTunnelDns = coreRunning
    ? []
    : tunnelDns.filter(ip => knownTunnel.length === 0 || knownTunnel.includes(ip))
  if (deadTunnelDns.length > 0 && !coreRunning) {
    problems.push({
      id: 'dns-dead-tunnel',
      severity: 'critical',
      title: 'DNS 指向隧道地址，但内核没在跑',
      detail: `${physical?.alias ?? '(未知网卡)'} 的 DNS 是 ${deadTunnelDns.join(', ')}，`
        + `而 ${config.core.coreProcessNames.join('/')} 没在运行 —— 这些地址没人应答，域名解析会全部超时。`,
      fixable: true,
    })
  }

  // ② 系统代理指向一个没人监听的端口 → 全部 HTTP 请求立即失败
  if (proxy.enabled === true) {
    const port = Number(String(proxy.server).split(':').pop())
    const listening = Number.isInteger(port) && port > 0
      ? await isPortListening(winCfg, port)
      : false
    if (!listening) {
      problems.push({
        id: 'proxy-dead-port',
        severity: 'critical',
        title: '系统代理指向没人监听的端口',
        detail: `WinINET 代理是 ${proxy.server}，但那个端口没有进程在听 —— 所有走系统代理的程序会立即连接失败。`,
        fixable: true,
      })
    }
  }

  // ③ 内核没跑但 TUN 网卡还在 → 路由黑洞
  const tunPresent = await hasTunAdapter(winCfg, config.discovery)
  if (tunPresent && !coreRunning) {
    problems.push({
      id: 'tun-orphan',
      severity: 'high',
      title: 'TUN 网卡还在，但内核没在跑',
      detail: 'TUN 网卡残留会让默认路由指向一个不存在的隧道，部分流量会直接黑洞。',
      fixable: false,
    })
  }

  const blocking = problems.filter(p => p.severity === 'critical')

  return {
    ok: blocking.length === 0,
    verdict: blocking.length > 0 ? 'broken' : (problems.length > 0 ? 'degraded' : 'healthy'),
    coreRunning,
    corePids,
    adapter: physical?.alias ?? '',
    dnsServers,
    tunnelDns,
    proxyEnabled: proxy.enabled === true,
    proxyServer: proxy.server ?? '',
    tunPresent,
    problems,
  }
}

/**
 * 自愈：把网络还原成可用状态。
 *
 * 只处理**能让网络立刻恢复**的事：DNS 重置、系统代理关闭。
 * 不碰 Clash 配置、不杀内核。
 *
 * @param {object} options
 * @param {object} options.config
 * @param {object} [options.report] inspectNetwork 的结果，省一次体检
 * @returns {Promise<{ok: boolean, actions: Array<object>}>}
 */
export async function healNetwork(options) {
  const { config } = options
  const winCfg = config.windows
  const report = options.report ?? await inspectNetwork({ config })
  const actions = []

  const dnsProblem = report.problems.find(p => p.id === 'dns-dead-tunnel')
  if (dnsProblem !== undefined && report.adapter !== '') {
    const result = await resetAdapterDns(winCfg, report.adapter)
    actions.push({
      id: 'reset-dns',
      ok: result.ok,
      detail: result.ok
        ? `${report.adapter} 的 DNS 已重置为自动获取`
        : (result.error ?? '重置失败（可能需要管理员权限）'),
    })
    if (result.ok) await flushDns(winCfg)
  }

  const proxyProblem = report.problems.find(p => p.id === 'proxy-dead-port')
  if (proxyProblem !== undefined) {
    const result = await clearSystemProxy(winCfg)
    actions.push({
      id: 'clear-proxy',
      ok: result.ok,
      detail: result.ok ? '系统代理已关闭' : (result.error ?? '关闭失败'),
    })
  }

  // 再体检一次，确认真的好了
  const after = await inspectNetwork({ config })

  return {
    ok: after.ok === true,
    actions,
    before: report.verdict,
    after: after.verdict,
    remaining: after.problems,
  }
}

/**
 * 重置某块网卡的 DNS 为自动获取，并清缓存。
 *
 * 用 `Set-DnsClientServerAddress -ResetServerAddresses`：对 DHCP 网卡
 * 会重新从 DHCP 拿回运营商 DNS，比手写一个地址安全。
 *
 * @param {object} cfg defaults.windows
 * @param {string} alias
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function resetAdapterDns(cfg, alias) {
  if (typeof alias !== 'string' || alias === '') return { ok: false, error: 'no adapter' }
  const safe = alias.replace(/'/g, "''")
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `Set-DnsClientServerAddress -InterfaceAlias '${safe}' -ResetServerAddresses -ErrorAction Stop`,
    "Write-Output 'ok'",
  ].join('\n')
  const result = await shell(cfg, script)
  const out = String(result?.stdout ?? '')
  if (!result.ok || !out.includes('ok')) {
    return { ok: false, error: (result?.stderr || out || 'needs elevation').slice(0, 200) }
  }
  return { ok: true }
}

/**
 * 清 DNS 缓存。
 * @param {object} cfg defaults.windows
 */
export async function flushDns(cfg) {
  await shell(cfg, 'ipconfig /flushdns | Out-Null; Write-Output "ok"')
}

/**
 * 端口有没有人在听。
 * @param {object} cfg
 * @param {number} port
 */
async function isPortListening(cfg, port) {
  const script = `
$c = Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen -ErrorAction SilentlyContinue
if ($c) { 'yes' } else { 'no' }
`
  const result = await shell(cfg, script)
  return String(result?.stdout ?? '').includes('yes')
}

/**
 * TUN 网卡在不在。
 * @param {object} cfg
 * @param {object} discovery
 */
async function hasTunAdapter(cfg, discovery) {
  const patterns = (discovery.tunAdapterPatterns ?? []).map(p => String(p).toLowerCase())
  if (patterns.length === 0) return false
  const result = await shell(cfg, "Get-NetAdapter -ErrorAction SilentlyContinue | ForEach-Object { $_.Name + '|' + $_.InterfaceDescription }")
  const text = String(result?.stdout ?? '').toLowerCase()
  return patterns.some(p => text.includes(p))
}

/**
 * 起一个守护：定时体检，命中就自愈。
 *
 * @param {object} options
 * @param {object} options.config
 * @param {(message: string) => void} [options.log]
 * @returns {{stop: () => void, tick: () => Promise<object>}}
 */
export function startWatchdog(options) {
  const { config } = options
  const log = options.log ?? (() => {})
  const intervalMs = Number(config.selfheal?.watchdogMs ?? 0) || 15000
  let timer = null
  let stopped = false
  let running = false

  const tick = async () => {
    if (stopped || running) return { skipped: true }
    running = true
    try {
      const report = await inspectNetwork({ config })
      if (report.ok === true) return { ok: true, verdict: report.verdict }
      log(`网络异常（${report.verdict}）：${report.problems.map(p => p.title).join('；')}`)
      const healed = await healNetwork({ config, report })
      log(healed.ok
        ? `已自愈：${healed.actions.filter(a => a.ok).map(a => a.id).join(', ') || '(无需动作)'}`
        : `自愈未完全成功，仍有：${healed.remaining.map(p => p.title).join('；')}`)
      return healed
    } catch (error) {
      log(`自愈过程出错：${String(error.message ?? error)}`)
      return { ok: false, error: String(error.message ?? error) }
    } finally {
      running = false
    }
  }

  const schedule = () => {
    if (stopped) return
    timer = setTimeout(() => {
      void tick().finally(schedule)
    }, intervalMs)
    // 别让守护拖住宿主退出
    if (typeof timer.unref === 'function') timer.unref()
  }

  // 启动时先跑一次：进程刚起时最可能撞上残留
  void tick().finally(schedule)

  return {
    tick,
    stop() {
      stopped = true
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    },
  }
}
