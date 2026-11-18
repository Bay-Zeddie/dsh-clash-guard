/**
 * Windows 侧泄漏面检测与控制。
 *
 * 纪律：需要管理员权限的动作如果没成，就如实回报错误，不假装成功。
 * 所有查询只读、零副作用。
 *
 * 覆盖 WinINET 系统代理、WinHTTP 代理、每网卡 DNS、DoH 自动升级、
 * 物理网卡 IPv6 绑定与全局地址。所有命令文本、注册表键、超时都来自
 * defaults.windows，代码里没有字面量。
 *
 * @module dsh-clash-guard/windows
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * 跑一段 PowerShell。
 * @param {object} cfg defaults.windows
 * @param {string} script
 * @param {number} [timeoutMs]
 * @returns {Promise<{ok: boolean, stdout: string, stderr: string}>}
 */
async function shell(cfg, script, timeoutMs) {
  try {
    const { stdout, stderr } = await run(cfg.powershell, [...cfg.powershellFlags, script], {
      windowsHide: true,
      timeout: timeoutMs ?? cfg.commandTimeoutMs,
      maxBuffer: cfg.maxBufferBytes,
    })
    return { ok: true, stdout, stderr }
  } catch (error) {
    return {
      ok: false,
      stdout: String(error.stdout ?? ''),
      stderr: String(error.stderr ?? error.message ?? ''),
    }
  }
}

/** 字段分隔符：用 tab，避免路径里的空格干扰。 */
const SEP = '\t'

/** 把值里的单引号转义成 PowerShell 单引号串可用的形式。 */
function quote(value) {
  return String(value).replace(/'/g, "''")
}

/** 生成刷新 WinINET 的 P/Invoke 片段。 */
function wininetRefresh(cfg, className) {
  const flags = cfg.wininetRefreshFlags.map(n => `[void][${className}]::InternetSetOption([IntPtr]::Zero, ${n}, [IntPtr]::Zero, 0)`).join('\n')
  return `
$sig = @'
using System;
using System.Runtime.InteropServices;
public static class ${className} {
  [DllImport("wininet.dll", SetLastError = true, CharSet = CharSet.Auto)]
  public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);
}
'@
Add-Type -TypeDefinition $sig -ErrorAction SilentlyContinue
${flags}
`
}

/**
 * 读 WinINET 系统代理。
 * @param {object} cfg defaults.windows
 */
export async function readSystemProxy(cfg) {
  const key = cfg.internetSettingsKey
  const script = [
    `$p = Get-ItemProperty '${key}' -ErrorAction SilentlyContinue;`,
    `'{0}${SEP}{1}${SEP}{2}${SEP}{3}' -f [int]$p.ProxyEnable, $p.ProxyServer, $p.ProxyOverride, $p.AutoConfigURL`,
  ].join(' ')
  const res = await shell(cfg, script)
  const cols = res.stdout.trim().split(SEP)
  return {
    enabled: String(cols[0] ?? '0').trim() === '1',
    server: String(cols[1] ?? '').trim(),
    override: String(cols[2] ?? '').trim(),
    autoConfigUrl: String(cols[3] ?? '').trim(),
  }
}

/**
 * 打开 WinINET 系统代理并刷新，让已在跑的进程也吃到新设置。
 * @param {object} cfg defaults.windows
 * @param {string} server 形如 `127.0.0.1:7897`
 * @param {string} override 绕过列表
 */
export async function setSystemProxy(cfg, server, override) {
  const key = cfg.internetSettingsKey
  const script = `
$ErrorActionPreference = 'Stop'
Set-ItemProperty '${key}' -Name ProxyServer -Value '${quote(server)}'
Set-ItemProperty '${key}' -Name ProxyOverride -Value '${quote(override)}'
Set-ItemProperty '${key}' -Name ProxyEnable -Value 1 -Type DWord
${wininetRefresh(cfg, 'ClashGuardWinInetOn')}
Write-Output 'ok'
`
  const res = await shell(cfg, script)
  return res.ok && res.stdout.includes('ok')
    ? { ok: true }
    : { ok: false, error: (res.stderr || 'elevation required').slice(0, 300) }
}

/** 关闭 WinINET 系统代理并刷新。 */
export async function clearSystemProxy(cfg) {
  const key = cfg.internetSettingsKey
  const script = `
$ErrorActionPreference = 'Stop'
Set-ItemProperty '${key}' -Name ProxyEnable -Value 0 -Type DWord
${wininetRefresh(cfg, 'ClashGuardWinInetOff')}
Write-Output 'ok'
`
  const res = await shell(cfg, script)
  return res.ok && res.stdout.includes('ok')
    ? { ok: true }
    : { ok: false, error: (res.stderr || 'elevation required').slice(0, 300) }
}

/** 读 WinHTTP 代理（服务/后台进程用）。 */
export async function readWinHttpProxy(cfg) {
  const res = await shell(cfg, cfg.netshShowProxy)
  const raw = res.stdout.trim()
  const direct = cfg.directAccessPatterns.some(p => raw.toLowerCase().includes(p.toLowerCase()))
  return { raw, direct, configured: !direct && raw !== '' }
}

/** 设置 WinHTTP 代理（需管理员）。 */
export async function setWinHttpProxy(cfg, server) {
  const res = await shell(cfg, `${cfg.netshSetProxy} ${server} | Out-String`)
  return res.ok ? { ok: true } : { ok: false, error: (res.stderr || res.stdout).slice(0, 300) }
}

/** 重置 WinHTTP 为直连（需管理员）。 */
export async function resetWinHttpProxy(cfg) {
  const res = await shell(cfg, `${cfg.netshResetProxy} | Out-String`)
  return res.ok ? { ok: true } : { ok: false, error: (res.stderr || res.stdout).slice(0, 300) }
}

/**
 * 读每块网卡的 DNS 服务器。
 * @param {object} cfg defaults.windows
 * @returns {Promise<Array<{alias: string, index: number, v4: string[], v6: string[]}>>}
 */
export async function readDnsServers(cfg) {
  const script = `
$rows = Get-DnsClientServerAddress -ErrorAction SilentlyContinue | Where-Object { $_.ServerAddresses.Count -gt 0 }
foreach ($r in $rows) {
  '{0}${SEP}{1}${SEP}{2}${SEP}{3}' -f $r.InterfaceAlias, $r.InterfaceIndex, $r.AddressFamily, ($r.ServerAddresses -join ',')
}
`
  const res = await shell(cfg, script)
  const map = new Map()
  for (const line of res.stdout.split(/\r?\n/)) {
    const cols = line.split(SEP)
    if (cols.length < 4) continue
    const [alias, index, family, servers] = cols
    const key = `${alias}${SEP}${index}`
    if (!map.has(key)) map.set(key, { alias, index: Number(index) || 0, v4: [], v6: [] })
    const entry = map.get(key)
    const list = servers.split(',').map(s => s.trim()).filter(Boolean)
    // AddressFamily 2 = IPv4, 23 = IPv6
    if (String(family).trim() === '2') entry.v4.push(...list)
    else entry.v6.push(...list)
  }
  return [...map.values()]
}

/**
 * 读 DoH 自动升级状态。
 * Windows 11 默认把已知 DNS 升级成 DoH，那样 `dns-hijack: any:53` 就拦不到，
 * 是真实的 DNS 泄漏面。
 * @param {object} cfg defaults.windows
 */
export async function readDohState(cfg) {
  const script = [
    `$v = (Get-ItemProperty '${cfg.autoDohKey}' -Name ${cfg.autoDohValue} -ErrorAction SilentlyContinue).${cfg.autoDohValue}`,
    `'auto={0}' -f $v`,
    `@(Get-DnsClientDohServerAddress -ErrorAction SilentlyContinue | ForEach-Object { '{0}={1}' -f $_.ServerAddress, $_.DohTemplate }) -join ';'`,
  ].join('\n')
  const res = await shell(cfg, script)
  const lines = res.stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean)
  const autoLine = lines.find(l => l.startsWith('auto=')) ?? 'auto='
  const raw = autoLine.slice('auto='.length).trim()
  const autoDoh = raw === '' ? 0 : Number(raw) || 0
  const entryLine = lines.find(l => !l.startsWith('auto=')) ?? ''
  const entries = entryLine.split(';').map(s => s.trim()).filter(Boolean)
  return { autoDoh, entries }
}

/** 关掉 DoH 自动升级（需管理员）：DNS 泄漏的最后一道闸。 */
export async function disableAutoDoh(cfg) {
  const script = `
$ErrorActionPreference = 'Stop'
$k = '${cfg.autoDohKey}'
if (-not (Test-Path $k)) { New-Item -Path $k -Force | Out-Null }
Set-ItemProperty $k -Name ${cfg.autoDohValue} -Value 0 -Type DWord
Write-Output 'ok'
`
  const res = await shell(cfg, script)
  return res.ok && res.stdout.includes('ok')
    ? { ok: true }
    : { ok: false, error: (res.stderr || 'elevation required').slice(0, 300) }
}

/**
 * 找物理网卡（承载默认路由、且不是虚拟/TUN 网卡的那块）。
 * @param {object} cfg defaults.windows
 * @param {object} discovery defaults.discovery
 * @returns {Promise<{alias: string, index: number, isTun: boolean}>}
 */
export async function resolvePhysicalAdapter(cfg, discovery) {
  const script = `
$routes = Get-NetRoute -DestinationPrefix '${cfg.defaultRoutePrefix}' -ErrorAction SilentlyContinue |
  Sort-Object RouteMetric, ifMetric | Select-Object -First 20
foreach ($r in $routes) {
  $a = Get-NetAdapter -InterfaceIndex $r.InterfaceIndex -ErrorAction SilentlyContinue
  if ($a) { '{0}${SEP}{1}${SEP}{2}' -f $a.Name, $a.InterfaceIndex, $a.InterfaceDescription }
}
`
  const res = await shell(cfg, script)
  const tunPatterns = discovery.tunAdapterPatterns.map(p => p.toLowerCase())
  const virtualPatterns = discovery.virtualAdapterPatterns.map(p => p.toLowerCase())
  const rows = []
  for (const line of res.stdout.split(/\r?\n/)) {
    const cols = line.split(SEP)
    if (cols.length < 3) continue
    rows.push({ alias: cols[0], index: Number(cols[1]) || 0, description: cols[2] })
  }
  // 物理网卡优先：既不是 TUN，也不是虚拟网卡
  for (const row of rows) {
    const hay = `${row.alias} ${row.description}`.toLowerCase()
    const isTun = tunPatterns.some(p => hay.includes(p))
    const isVirtual = virtualPatterns.some(p => hay.includes(p))
    if (!isTun && !isVirtual) return { alias: row.alias, index: row.index, isTun: false }
  }
  // 退一步：只要不是 TUN 就行
  for (const row of rows) {
    const hay = `${row.alias} ${row.description}`.toLowerCase()
    if (!tunPatterns.some(p => hay.includes(p))) {
      return { alias: row.alias, index: row.index, isTun: false }
    }
  }
  return { alias: '', index: 0, isTun: rows.length > 0 }
}

/**
 * 读物理网卡自己的 IPv4 地址（不是 DNS 服务器地址）。
 *
 * **别把这两者搞混**：`readDnsServers` 给的是解析器地址（TUN 下通常是
 * `198.18.0.2`），而这里要的是**本机网卡地址**（如 `192.168.1.5`）。
 * 用 DNS 地址去 `net.connect({localAddress})` 会直接 EADDRNOTAVAIL，
 * 那样「物理网卡旁路」探针就永远报「被拦下」——一个假阳性。
 *
 * @param {object} cfg defaults.windows
 * @param {object} discovery defaults.discovery
 * @param {string} alias 网卡名
 * @returns {Promise<{addresses: string[], primary: string}>}
 */
export async function readAdapterAddresses(cfg, discovery, alias) {
  if (typeof alias !== 'string' || alias === '') {
    return { addresses: [], primary: '' }
  }
  const script = `
@(Get-NetIPAddress -InterfaceAlias '${quote(alias)}' -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.AddressState -eq 'Preferred' -and $_.IPAddress -notlike '169.254.*' } |
  ForEach-Object { $_.IPAddress }) -join ','
`
  const res = await shell(cfg, script)
  const addresses = res.stdout.trim().split(',').map(s => s.trim()).filter(Boolean)
  return { addresses, primary: addresses.length > 0 ? addresses[0] : '' }
}

/**
 * 读物理网卡的 IPv6 绑定状态与全局地址。
 * @param {object} cfg defaults.windows
 * @param {object} discovery defaults.discovery
 */
export async function readIpv6State(cfg, discovery) {
  const adapter = await resolvePhysicalAdapter(cfg, discovery)
  if (adapter.alias === '') {
    return { physicalAdapter: '', adapterIndex: 0, ipv6Bound: false, globalAddresses: [], resolvable: false }
  }
  const script = `
$b = Get-NetAdapterBinding -Name '${quote(adapter.alias)}' -ComponentID ${cfg.ipv6ComponentId} -ErrorAction SilentlyContinue
if ($b) { [int]$b.Enabled } else { '' }
@(Get-NetIPAddress -InterfaceAlias '${quote(adapter.alias)}' -AddressFamily IPv6 -ErrorAction SilentlyContinue |
  Where-Object { $_.AddressState -eq 'Preferred' -and $_.IPAddress -notlike 'fe80*' } |
  ForEach-Object { $_.IPAddress }) -join ','
`
  const res = await shell(cfg, script)
  const lines = res.stdout.split(/\r?\n/)
  const bound = String(lines[0] ?? '').trim()
  const global = String(lines.slice(1).join(',') ?? '').split(',').map(s => s.trim()).filter(Boolean)
  return {
    physicalAdapter: adapter.alias,
    adapterIndex: adapter.index,
    ipv6Bound: bound === '1',
    globalAddresses: global,
    resolvable: true,
  }
}

/** 关闭物理网卡的 IPv6 绑定（需管理员）。 */
export async function disablePhysicalIpv6(cfg, alias) {
  if (alias === '') return { ok: false, error: 'no physical adapter resolved' }
  const script = `Disable-NetAdapterBinding -Name '${quote(alias)}' -ComponentID ${cfg.ipv6ComponentId} -ErrorAction Stop | Out-Null; Write-Output 'ok'`
  const res = await shell(cfg, script)
  return res.ok && res.stdout.includes('ok')
    ? { ok: true }
    : { ok: false, error: (res.stderr || 'elevation required').slice(0, 300) }
}

/** 恢复物理网卡的 IPv6 绑定（需管理员）。 */
export async function enablePhysicalIpv6(cfg, alias) {
  if (alias === '') return { ok: false, error: 'no physical adapter resolved' }
  const script = `Enable-NetAdapterBinding -Name '${quote(alias)}' -ComponentID ${cfg.ipv6ComponentId} -ErrorAction Stop | Out-Null; Write-Output 'ok'`
  const res = await shell(cfg, script)
  return res.ok && res.stdout.includes('ok')
    ? { ok: true }
    : { ok: false, error: (res.stderr || 'elevation required').slice(0, 300) }
}

/** 把物理网卡 DNS 指到指定服务器（需管理员）。 */
export async function pointDns(cfg, alias, server) {
  if (alias === '') return { ok: false, error: 'no physical adapter resolved' }
  const script = `Set-DnsClientServerAddress -InterfaceAlias '${quote(alias)}' -ServerAddresses '${quote(server)}' -ErrorAction Stop; Write-Output 'ok'`
  const res = await shell(cfg, script)
  return res.ok && res.stdout.includes('ok')
    ? { ok: true }
    : { ok: false, error: (res.stderr || 'elevation required').slice(0, 300) }
}

/** 恢复网卡 DNS 为自动获取（需管理员）。 */
export async function resetDns(cfg, alias) {
  if (alias === '') return { ok: false, error: 'no physical adapter resolved' }
  const script = `Set-DnsClientServerAddress -InterfaceAlias '${quote(alias)}' -ResetServerAddresses -ErrorAction Stop; Write-Output 'ok'`
  const res = await shell(cfg, script)
  return res.ok && res.stdout.includes('ok')
    ? { ok: true }
    : { ok: false, error: (res.stderr || 'elevation required').slice(0, 300) }
}

/** 当前进程是否管理员。 */
export async function isElevated(cfg) {
  const script = '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'
  const res = await shell(cfg, script, cfg.commandTimeoutMs)
  return /true/i.test(res.stdout)
}

/**
 * 读 TUN 网卡实际配置的 DNS 服务器（用于推导网关，避免硬编码 198.18.0.2）。
 * @param {object} cfg defaults.windows
 * @param {object} discovery defaults.discovery
 */
export async function readTunDns(cfg, discovery) {
  const script = `
$adapters = Get-NetAdapter -ErrorAction SilentlyContinue
foreach ($a in $adapters) {
  $hay = ('{0} {1}' -f $a.Name, $a.InterfaceDescription).ToLower()
  '{0}${SEP}{1}${SEP}{2}' -f $a.Name, $a.InterfaceIndex, $a.InterfaceDescription
}
`
  const res = await shell(cfg, script)
  const tunPatterns = discovery.tunAdapterPatterns.map(p => p.toLowerCase())
  const tunAliases = []
  for (const line of res.stdout.split(/\r?\n/)) {
    const cols = line.split(SEP)
    if (cols.length < 3) continue
    const hay = `${cols[0]} ${cols[2]}`.toLowerCase()
    if (tunPatterns.some(p => hay.includes(p))) tunAliases.push(cols[0])
  }
  if (tunAliases.length === 0) return { adapter: '', servers: [] }
  const servers = await readDnsServers(cfg)
  const hit = servers.find(s => tunAliases.includes(s.alias))
  return { adapter: tunAliases[0], servers: hit === undefined ? [] : [...hit.v4, ...hit.v6] }
}

export { shell, SEP }
