/**
 * 泄漏检测引擎 —— 把「是不是真的暴露了」拆成可判定的独立探针。
 *
 * 本模块只做**检测**，不做修复；修复在 guard.js。
 *
 * 六个探针，对应六种真实泄漏面（来源：mihomo 源码 + VPN 泄漏研究）：
 *
 *   1. **出口 IP**       —— 走代理问外部，拿到的是节点出口
 *   2. **多源交叉**       —— 多个独立端点，任一不一致就说明有分流/劫持
 *   3. **DNS 解析路径**   —— 用 mihomo 的 `/dns/query` 问，看它是否走代理解析
 *   4. **按进程的连接**   —— `/connections` 的 `process` 字段，找谁在直连
 *   5. **物理网卡旁路**   —— 绑物理网卡能否直连出去（strict-route 的真实效果）
 *   6. **IPv6 旁路**      —— 有 v6 全局地址时能否直达
 *
 * 所有判定都返回结构化结果，不抛异常 —— 探针失败是一种状态，不是崩溃。
 *
 * @module dsh-clash-guard/leaks
 */
import net from 'node:net'
import dns from 'node:dns'
import { getJson } from './mihomo.js'
import { probeViaProxy, looksLikeIp } from './egress.js'
import { shell } from './windows.js'

/* ------------------------------------------------------------------ *
 * 探针 1/2：出口 IP 与多源交叉
 * ------------------------------------------------------------------ */

/**
 * 用多个独立端点取出口 IP 并交叉验证。
 *
 * **为什么不能只问一个端点**：单点可能被 CDN 就近调度、可能缓存、
 * 也可能被中间设备改写。两个端点给出不同答案时，说明链路有分流或劫持 ——
 * 那本身就是泄漏信号，比「都答同一个 IP」更值得报警。
 *
 * @param {object} options
 * @param {number} options.mixedPort
 * @param {object} options.egress defaults.egress
 * @returns {Promise<{ok: boolean, ip: string, consensus: boolean, answers: Array<object>}>}
 */
export async function probeEgressMulti(options) {
  const { mixedPort, egress } = options
  const endpoints = Array.isArray(egress.endpoints) ? egress.endpoints : []
  const answers = []
  const ips = new Map()

  // 并发问全部端点：单点慢不会拖住整体
  const results = await Promise.all(endpoints.map(async (url) => {
    const one = await probeViaProxy({ mixedPort, egress: { ...egress, endpoints: [url] }, proxyHost: egress.proxyHost })
    return { url, ok: one.ok === true, ip: one.ok === true ? one.ip : '', error: one.ok === true ? '' : (one.error ?? '') }
  }))

  for (const result of results) {
    answers.push(result)
    if (result.ok && looksLikeIp(result.ip)) {
      ips.set(result.ip, (ips.get(result.ip) ?? 0) + 1)
    }
  }

  const ranked = [...ips.entries()].sort((a, b) => b[1] - a[1])
  const winner = ranked.length > 0 ? ranked[0][0] : ''
  const consensus = ranked.length <= 1

  return {
    ok: winner !== '',
    ip: winner,
    consensus,
    distinct: ranked.map(([ip, count]) => ({ ip, count })),
    answers,
  }
}

/* ------------------------------------------------------------------ *
 * 探针 3：DNS 解析路径
 * ------------------------------------------------------------------ */

/**
 * 用 mihomo 自己的 `/dns/query` 做一次解析，判断它走的是哪条路。
 *
 * **这一条能抓到的东西**：如果 `dns.enable` 是 false，`/dns/query` 直接
 * 回 500（"DNS section is disabled"）—— 那就意味着系统解析完全绕过了
 * mihomo，DNS 泄漏是确定的。
 *
 * 如果它能答，再看答案是不是 fake-ip 段：fake-ip 说明走了内部 DNS 模块
 * （好）；真实公网 IP 说明它真的去问了上游（也可能好，取决于配置）。
 *
 * @param {object} options
 * @param {object} options.target
 * @param {object} options.config
 * @returns {Promise<object>}
 */
export async function probeDnsPath(options) {
  const { target, config } = options
  const name = config.leaks.dnsProbeName
  const type = config.leaks.dnsProbeType

  let payload
  try {
    payload = await getJson(target, `/dns/query?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`)
  } catch (error) {
    const message = String(error.message ?? error)
    // 500 + "DNS section is disabled" = DNS 没启用
    if (/DNS section is disabled/i.test(message) || /500/.test(message)) {
      return {
        ok: false,
        state: 'disabled',
        detail: 'mihomo 的 DNS 模块未启用，系统解析完全绕过它（DNS 泄漏已确定）',
        answers: [],
      }
    }
    return { ok: false, state: 'error', detail: message.slice(0, 200), answers: [] }
  }

  const answers = Array.isArray(payload?.Answer)
    ? payload.Answer.filter(record => record.type === 1 || record.type === 28).map(record => String(record.data ?? '').trim())
    : []

  if (answers.length === 0) {
    return { ok: false, state: 'empty', detail: `${name} 无 A/AAAA 答复`, answers: [] }
  }

  const fakeRange = String(config.leaks.fakeIpRange ?? '')
  const isFakeIp = fakeRange !== '' && answers.every(ip => inCidr(ip, fakeRange))

  return {
    ok: true,
    state: isFakeIp ? 'fake-ip' : 'real',
    detail: isFakeIp
      ? `${name} → ${answers.join(',')}（fake-ip 段，解析走 mihomo 内部）`
      : `${name} → ${answers.join(',')}（真实地址，mihomo 已向上游解析）`,
    answers,
  }
}

/** 判断 IP 是否落在 CIDR 内（只支持 IPv4）。 */
function inCidr(ip, cidr) {
  const [base, bitsRaw] = cidr.split('/')
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

/* ------------------------------------------------------------------ *
 * 探针 4：按进程找直连
 * ------------------------------------------------------------------ */

/**
 * 从 `/connections` 里按进程统计直连。
 *
 * **这是最有实战价值的一条**：mihomo 的每条连接都带 `metadata.process`
 * 和 `metadata.processPath`，也有 `chains`。所以能直接回答
 * 「是不是某个程序一直在绕过代理」——那比任何全局开关都具体。
 *
 * @param {object} options
 * @param {object} options.target
 * @param {object} options.config
 * @returns {Promise<object>}
 */
export async function probeProcessLeaks(options) {
  const { target, config } = options
  const terminal = config.bypass.terminalNames

  let payload
  try {
    payload = await getJson(target, '/connections')
  } catch (error) {
    return { ok: false, detail: String(error.message ?? error).slice(0, 160), total: 0, direct: [], byProcess: [] }
  }

  const list = Array.isArray(payload?.connections) ? payload.connections : []
  const byProcess = new Map()

  for (const conn of list) {
    const meta = conn.metadata ?? {}
    const chains = Array.isArray(conn.chains) ? conn.chains : []
    const isDirect = chains.length === 1 && terminal.includes(chains[0])
    const name = String(meta.process ?? '').trim() || '(未知进程)'

    if (!byProcess.has(name)) {
      byProcess.set(name, {
        process: name,
        path: String(meta.processPath ?? ''),
        total: 0,
        direct: 0,
        hosts: new Set(),
      })
    }
    const entry = byProcess.get(name)
    entry.total += 1
    if (isDirect) {
      entry.direct += 1
      const host = String(meta.host ?? meta.destinationIP ?? '').trim()
      if (host !== '' && entry.hosts.size < 5) entry.hosts.add(host)
    }
  }

  const rows = [...byProcess.values()]
    .map(entry => ({
      process: entry.process,
      path: entry.path,
      total: entry.total,
      direct: entry.direct,
      hosts: [...entry.hosts],
    }))
    .sort((a, b) => b.direct - a.direct || b.total - a.total)

  const direct = rows.filter(row => row.direct > 0)

  return {
    ok: true,
    total: list.length,
    direct,
    byProcess: rows,
    detail: direct.length === 0
      ? `${list.length} 条连接中没有直连`
      : `${direct.length} 个进程有直连：${direct.slice(0, 3).map(r => `${r.process}(${r.direct})`).join(', ')}`,
  }
}

/* ------------------------------------------------------------------ *
 * 探针 5：物理网卡旁路
 * ------------------------------------------------------------------ */

/**
 * 探测「绑定物理网卡能否直连出去」。
 *
 * **这是 strict-route 的真实效果检验**，比读配置值可靠得多：
 *
 *   · 绑物理网卡 + TUN 严格路由生效 → 连接失败（好）；
 *   · 绑物理网卡 + 能连通       → 那条路在绕 TUN（坏）。
 *
 * 用 `net.connect({ localAddress })` 指定源地址发起 TCP 连接，
 * 目标用不可路由地址（不会真的打到别人），只看「能否建立」与「错误类型」。
 *
 * @param {object} options
 * @param {string} options.localAddress 物理网卡的本机 IPv4
 * @param {object} options.config
 * @returns {Promise<object>}
 */
export function probeInterfaceBypass(options) {
  const { localAddress, config } = options
  const probe = config.leaks.interfaceProbe
  if (typeof localAddress !== 'string' || localAddress === '') {
    return Promise.resolve({ ok: false, state: 'unknown', detail: '没有物理网卡地址可用' })
  }

  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }

    let socket
    try {
      socket = net.connect({
        host: probe.host,
        port: probe.port,
        localAddress,
        timeout: probe.timeoutMs,
      })
    } catch (error) {
      finish({ ok: false, state: 'unknown', detail: `无法绑定 ${localAddress}：${error.message}` })
      return
    }

    socket.on('connect', () => {
      socket.destroy()
      finish({
        ok: false,
        state: 'bypass',
        detail: `绑定 ${localAddress} 能连到 ${probe.host}:${probe.port} —— 这条路径绕过了 TUN`,
      })
    })
    socket.on('timeout', () => {
      socket.destroy()
      finish({ ok: true, state: 'blocked', detail: `绑定 ${localAddress} 超时（被 TUN 拦下，符合预期）` })
    })
    socket.on('error', (error) => {
      // ECONNREFUSED 说明包已经出去了（对端拒），那也算旁路
      const code = String(error.code ?? '')
      if (code === 'ECONNREFUSED') {
        finish({ ok: false, state: 'bypass', detail: `绑定 ${localAddress} 的包到达了对端（${code}）—— 绕过了 TUN` })
        return
      }
      finish({ ok: true, state: 'blocked', detail: `绑定 ${localAddress} 失败（${code || error.message}）—— 被拦下` })
    })
    socket.setTimeout(probe.timeoutMs)
  })
}

/* ------------------------------------------------------------------ *
 * 探针 6：IPv6 旁路
 * ------------------------------------------------------------------ */

/**
 * 有 IPv6 全局地址时，检查能否直达外部。
 *
 * IPv6 是最经典的泄漏：v4 走隧道，v6 直出，很多 VPN 配置都栽在这里。
 *
 * @param {object} options
 * @param {string[]} options.globalAddresses
 * @param {object} options.config
 * @returns {Promise<object>}
 */
export function probeIpv6Bypass(options) {
  const { globalAddresses, config } = options
  if (!Array.isArray(globalAddresses) || globalAddresses.length === 0) {
    return Promise.resolve({ ok: true, state: 'absent', detail: '物理网卡没有 IPv6 全局地址（无此泄漏面）' })
  }

  const probe = config.leaks.ipv6Probe
  const address = globalAddresses[0]

  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }

    let socket
    try {
      socket = net.connect({
        host: probe.host,
        port: probe.port,
        localAddress: address,
        timeout: probe.timeoutMs,
        family: 6,
      })
    } catch (error) {
      finish({ ok: false, state: 'unknown', detail: `无法绑定 ${address}：${error.message}` })
      return
    }

    socket.on('connect', () => {
      socket.destroy()
      finish({ ok: false, state: 'bypass', detail: `${address} 能直连 ${probe.host}:${probe.port} —— IPv6 旁路存在` })
    })
    socket.on('timeout', () => {
      socket.destroy()
      finish({ ok: true, state: 'blocked', detail: `${address} 超时（被拦下）` })
    })
    socket.on('error', (error) => {
      const code = String(error.code ?? '')
      if (code === 'ECONNREFUSED') {
        finish({ ok: false, state: 'bypass', detail: `${address} 的包到达对端（${code}）—— IPv6 旁路存在` })
        return
      }
      finish({ ok: true, state: 'blocked', detail: `${address} 失败（${code || error.message}）` })
    })
    socket.setTimeout(probe.timeoutMs)
  })
}

/**
 * 整机连接审计：枚举这台电脑**真实活着的全部 TCP 连接**，按进程点名谁在直连。
 *
 * ## 与 process-direct 的区别
 *
 * `process-direct` 读的是 mihomo 的 `/connections` —— 那里面只有**经过 mihomo
 * 的连接**。一个绑了物理网卡的程序根本不进 mihomo，那份表里看不到它。
 * 本探针走 Windows 自己的连接表（`Get-NetTCPConnection`），看见的是**整机**。
 *
 * ## 分类规则
 *
 *   · 源地址是回环            → 跳过（本机栈内部）
 *   · 源地址在 fake-ip 段     → 走 TUN（安全）
 *   · 目的地址是回环          → 本机服务（无害）
 *   · 目的地址在 fake-ip 段   → 走 TUN DNS 路径（安全）
 *   · 目的地址是局域网/私网   → LAN（不算互联网泄漏）
 *   · **源地址 = 物理网卡 IP** → 直连（泄漏：这个进程正在用真 IP 出网）
 *
 * mihomo 自己连节点的连接也是「源=物理网卡」，必须按进程名排除 ——
 * 隧道本身从物理网卡出去是天经地义的。
 *
 * 已知局限：只覆盖 TCP。UDP（WebRTC STUN 等）不在 Windows 连接表里带远端，
 * 那条泄漏面由 interface-bypass 探针另行覆盖。
 *
 * @param {object} options
 * @param {object} options.config
 * @param {string} options.physicalIp 物理网卡 IPv4
 * @returns {Promise<{ok: boolean, rows: Array<object>, directTotal: number, detail: string}>}
 */
export async function probeMachineTraffic(options) {
  const { config, physicalIp } = options
  if (typeof physicalIp !== 'string' || physicalIp === '') {
    return { ok: false, rows: [], directTotal: 0, detail: '没有物理网卡地址，整机连接分类不可用' }
  }
  const coreNames = (config.core.coreProcessNames ?? []).map(n => String(n).toLowerCase())
  const fakePrefix = String(config.leaks.fakeIpRange ?? '198.18.0.0/15').split('/')[0] + '.'

  // $phys 由调用方从 Get-NetIPAddress 读出（IP 格式固定，无注入面）
  const script = [
    `$phys = '${physicalIp}'`,
    `$fake = '${fakePrefix}'`,
    '$items = @()',
    'foreach ($c in (Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue)) {',
    '  $la = [string]$c.LocalAddress',
    '  $ra = [string]$c.RemoteAddress',
    "  if ($la -eq '127.0.0.1' -or $la -eq '::1') { continue }",
    '  if ($la.StartsWith($fake)) { continue }',
    "  if ($ra -eq '127.0.0.1' -or $ra -eq '::1') { continue }",
    "  $cls = 'other'",
    "  if ($ra.StartsWith($fake)) { $cls = 'tun' }",
    "  elseif ($ra -match '^(10\\.|172\\.(1[6-9]|2[0-9]|3[01])\\.|192\\.168\\.|169\\.254\\.|fe80:|fd[0-9a-f]{2}:)') { $cls = 'lan' }",
    "  elseif ($la -eq $phys) { $cls = 'direct' }",
    "  if ($cls -ne 'direct') { continue }",
    '  $items += [string]$c.OwningProcess + \'|\' + $ra + \':\' + [string]$c.RemotePort',
    '}',
    'if ($items.Count -eq 0) { Write-Output \'none\'; exit 0 }',
    '$names = @{}',
    'Get-Process -ErrorAction SilentlyContinue | ForEach-Object { $names[[int]$_.Id] = $_.ProcessName }',
    'foreach ($g in ($items | Group-Object { ($_ -split \'\\|\')[0] })) {',
    '  $p2 = [int]$g.Name',
    '  $pname = if ($names.ContainsKey($p2)) { $names[$p2] } else { \'pid:\' + $g.Name }',
    '  $remotes = ($g.Group | ForEach-Object { ($_ -split \'\\|\')[1] } | Select-Object -First 3) -join \',\'',
    "  '{0}|{1}|{2}' -f $pname, $g.Count, $remotes",
    '}',
  ].join('\n')

  const result = await shell(config.windows, script)
  const out = String(result?.stdout ?? '').trim()

  if (!result?.ok && out === '') {
    return { ok: false, rows: [], directTotal: 0, detail: (result?.stderr || '无法枚举整机连接').slice(0, 160) }
  }
  if (out === '' || out === 'none') {
    return { ok: true, rows: [], directTotal: 0, detail: '整机没有绕过代理的直连 TCP 连接' }
  }

  const rows = []
  let directTotal = 0
  for (const line of out.split(/\r?\n/)) {
    const cols = line.split('|')
    if (cols.length < 3) continue
    const name = cols[0].trim()
    if (coreNames.includes(name.toLowerCase())) continue // 隧道自己的出网，天经地义
    const count = Number(cols[1]) || 0
    directTotal += count
    rows.push({ process: name, count, remotes: cols[2] })
  }
  rows.sort((a, b) => b.count - a.count)

  return {
    ok: true,
    rows,
    directTotal,
    detail: rows.length === 0
      ? '整机没有绕过代理的直连 TCP 连接'
      : `${rows.length} 个进程在绕过代理直连（共 ${directTotal} 条）：${rows.slice(0, 4).map(r => `${r.process}(${r.count})`).join(', ')}`,
  }
}

/* ------------------------------------------------------------------ *
 * 探针 7：系统解析器是否指向 TUN
 * ------------------------------------------------------------------ */

/**
 * 用系统解析器直接查一个域名，看结果是不是 fake-ip。
 *
 * 与探针 3 的区别：那个问 mihomo「你会怎么解析」，这个问系统
 * 「你实际解析成什么」。两者不一致就说明系统没走 mihomo。
 *
 * @param {object} options
 * @param {object} options.config
 * @returns {Promise<object>}
 */
export async function probeSystemResolver(options) {
  const { config } = options
  const name = config.leaks.dnsProbeName
  const fakeRange = String(config.leaks.fakeIpRange ?? '')

  let addresses = []
  try {
    addresses = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), config.leaks.dnsProbeTimeoutMs)
      dns.resolve4(name, (error, list) => {
        clearTimeout(timer)
        if (error) reject(error)
        else resolve(Array.isArray(list) ? list : [])
      })
    })
  } catch (error) {
    return {
      ok: false,
      state: 'error',
      detail: `系统解析 ${name} 失败：${String(error.message ?? error).slice(0, 120)}`,
      answers: [],
    }
  }

  if (addresses.length === 0) {
    return { ok: false, state: 'empty', detail: `系统解析 ${name} 无结果`, answers: [] }
  }

  const allFake = fakeRange !== '' && addresses.every(ip => inCidr(ip, fakeRange))
  return {
    ok: allFake,
    state: allFake ? 'fake-ip' : 'real',
    detail: allFake
      ? `${name} → ${addresses.join(',')}（系统解析走 mihomo fake-ip）`
      : `${name} → ${addresses.join(',')}（系统解析得到真实地址，未走 fake-ip）`,
    answers: addresses,
  }
}

/**
 * 检查默认路由是否有**多条同 metric** 的 0.0.0.0/0。
 *
 * **这是本次开发最重要的发现**。真机实测：
 *
 *   InterfaceAlias  NextHop        RouteMetric
 *   WLAN            10.252.28.18   0
 *   Meta (TUN)      198.18.0.2     0
 *
 * 两条默认路由 metric 相同 —— Windows 的选路结果不确定，绑定物理网卡
 * 的程序能真的直连出去（`curl --interface 10.252.28.236` 实测拿到 301）。
 *
 * 而 `strict-route: true` 写进了配置也没用：它没有把 WLAN 那条默认路由压下去。
 * 所以「配置值」和「实际效果」是两件事，插件必须**看路由表**，不能只看配置。
 *
 * @param {object} options
 * @param {object} options.cfg defaults.windows
 * @param {string} options.tunPattern TUN 网卡名匹配模式（小写）
 * @returns {Promise<object>}
 */
export function probeDefaultRoutes(options) {
  const { cfg, tunPatterns } = options
  const script = `
$rows = Get-NetRoute -DestinationPrefix '${cfg.defaultRoutePrefix}' -ErrorAction SilentlyContinue |
  ForEach-Object {
    $a = Get-NetAdapter -InterfaceIndex $_.InterfaceIndex -ErrorAction SilentlyContinue
    if ($a) { '{0}\t{1}\t{2}\t{3}' -f $a.Name, $_.NextHop, $_.RouteMetric, $a.InterfaceDescription }
  }
$rows
`
  return shell(cfg, script).then((result) => {
    // shell 返回 { ok, stdout, stderr }，不是裸字符串
    const out = typeof result === 'string' ? result : String(result?.stdout ?? '')
    const routes = []
    for (const line of out.split(/\r?\n/)) {
      const cols = line.split('\t')
      if (cols.length < 4) continue
      routes.push({
        alias: cols[0].trim(),
        nextHop: cols[1].trim(),
        metric: Number(cols[2]) || 0,
        description: cols[3].trim(),
      })
    }

    const patterns = (tunPatterns ?? []).map(p => p.toLowerCase())
    const isTun = route => patterns.some(p => `${route.alias} ${route.description}`.toLowerCase().includes(p))
    const tunRoutes = routes.filter(isTun)
    const physicalRoutes = routes.filter(route => !isTun(route))

    // 最危险的情况：物理网卡与 TUN 的默认路由 metric 相同
    const tunMetric = tunRoutes.length > 0 ? Math.min(...tunRoutes.map(r => r.metric)) : null
    const competing = tunMetric === null
      ? []
      : physicalRoutes.filter(route => route.metric <= tunMetric)

    return {
      ok: competing.length === 0,
      state: competing.length === 0 ? 'tun-wins' : 'competing',
      routes,
      tunRoutes,
      competing,
      detail: tunMetric === null
        ? '没有 TUN 默认路由（TUN 可能没接管）'
        : competing.length === 0
          ? `TUN metric=${tunMetric}，物理网卡都更差 —— 默认路由归 TUN`
          : `物理网卡与 TUN 的默认路由 metric 竞争：${competing.map(r => `${r.alias}(metric ${r.metric})`).join(', ')}`
            + ` vs TUN(metric ${tunMetric}) —— 绑物理网卡的流量可能直连`,
    }
  })
}

/**
 * 修掉默认路由竞争：抬高物理网卡默认路由的 metric。
 *
 * ## ⚠️ 实测结论：这一条**单独用无效**
 *
 * 真机实验（2026-11-18）：
 *
 *   metric=0    → `curl --interface 10.252.28.236 http://1.1.1.1/` → HTTP 301
 *   metric=9000 → `curl --interface 10.252.28.236 http://1.1.1.1/` → HTTP 301
 *
 * 路由表确实变成 `tun-wins` 了，但**绑定源 IP 的流量仍然直连出去**。
 * 原因：Windows 在 `bind()` 到某个源地址时，会强制走该地址所属的接口，
 * **完全无视路由 metric**。
 *
 * 所以这个函数保留但**不再是主要手段** —— 它只解决「不绑卡的普通流量」
 * 的选路确定性，对「主动绑卡的程序」无效。
 *
 * 真正能堵住绑卡流量的是 {@link blockPhysicalGateway}：把物理网卡的
 * 网关从路由表里摘掉，让它根本没有出网路径。
 *
 * @param {object} options
 * @param {object} options.cfg defaults.windows
 * @param {string} options.alias 物理网卡名
 * @param {number} options.metric 目标 metric
 * @returns {Promise<{ok: boolean, detail: string}>}
 */
export async function raisePhysicalRouteMetric(options) {
  const { cfg, alias, metric } = options
  if (typeof alias !== 'string' || alias === '') {
    return { ok: false, detail: '没有物理网卡名' }
  }
  const script = `
$ErrorActionPreference = 'Stop'
$routes = Get-NetRoute -InterfaceAlias '${alias}' -DestinationPrefix '${cfg.defaultRoutePrefix}' -ErrorAction SilentlyContinue
if (-not $routes) { Write-Output 'no-route'; exit 0 }
foreach ($r in $routes) {
  Set-NetRoute -InterfaceIndex $r.InterfaceIndex -DestinationPrefix $r.DestinationPrefix -RouteMetric ${metric} -ErrorAction Stop
}
Write-Output 'ok'
`
  const result = await shell(cfg, script)
  const out = String(result?.stdout ?? '')
  if (!result.ok || !out.includes('ok')) {
    return { ok: false, detail: (result?.stderr || out || 'needs elevation').slice(0, 200) }
  }
  return { ok: true, detail: `${alias} 默认路由 metric 已设为 ${metric}（注意：对绑卡流量无效）` }
}

/**
 * **真正堵住绑卡流量**：把物理网卡的默认网关从路由表移除。
 *
 * 原理：绑卡流量的下一跳是物理网卡的网关。网关路由没了，内核就无法
 * 为「源地址=物理网卡 IP、目的=公网」的包找到下一跳，`bind` 出去会
 * 直接失败（EHOSTUNREACH / ENETUNREACH）—— 那正是我们要的效果。
 *
 * TUN 不受影响：它的网关（`198.18.0.2`）是另一条路由。
 *
 * 撤销时按基线把网关路由加回去。
 *
 * @param {object} options
 * @param {object} options.cfg defaults.windows
 * @param {string} options.alias 物理网卡名
 * @returns {Promise<{ok: boolean, removed: Array<object>, detail: string}>}
 */
export async function blockPhysicalGateway(options) {
  const { cfg, alias } = options
  if (typeof alias !== 'string' || alias === '') {
    return { ok: false, removed: [], detail: '没有物理网卡名' }
  }

  // 先读出来，撤销时要照着加回去
  const readScript = `
$rows = Get-NetRoute -InterfaceAlias '${alias}' -DestinationPrefix '${cfg.defaultRoutePrefix}' -ErrorAction SilentlyContinue
foreach ($r in $rows) { '{0}|{1}|{2}' -f $r.DestinationPrefix, $r.NextHop, $r.RouteMetric }
`
  const readRes = await shell(cfg, readScript)
  const removed = String(readRes?.stdout ?? '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [destination, nextHop, metric] = line.split('|')
      return { destination, nextHop, metric: Number(metric) || 0 }
    })

  if (removed.length === 0) {
    return { ok: true, removed: [], detail: `${alias} 没有默认路由可摘` }
  }

  const removeScript = `
$ErrorActionPreference = 'Stop'
$removed = 0
foreach ($r in (Get-NetRoute -InterfaceAlias '${alias}' -DestinationPrefix '${cfg.defaultRoutePrefix}' -ErrorAction SilentlyContinue)) {
  Remove-NetRoute -InterfaceIndex $r.InterfaceIndex -DestinationPrefix $r.DestinationPrefix -NextHop $r.NextHop -Confirm:$false -ErrorAction Stop
  $removed++
}
Write-Output ('ok:' + $removed)
`
  const res = await shell(cfg, removeScript)
  const out = String(res?.stdout ?? '')
  if (!res.ok || !out.includes('ok:')) {
    return { ok: false, removed: [], detail: (res?.stderr || out || 'needs elevation').slice(0, 200) }
  }

  const count = Number(out.split('ok:')[1]) || removed.length
  return {
    ok: true,
    removed,
    detail: `${alias} 的 ${count} 条默认网关已摘除 —— 绑卡流量无处可去`,
  }
}

/**
 * 恢复物理网卡的默认网关。
 * @param {object} options
 * @param {object} options.cfg defaults.windows
 * @param {string} options.alias
 * @param {Array<{destination: string, nextHop: string, metric: number}>} options.routes 基线路由
 * @returns {Promise<{ok: boolean, detail: string}>}
 */
export async function restorePhysicalGateway(options) {
  const { cfg, alias, routes } = options
  if (typeof alias !== 'string' || alias === '') {
    return { ok: false, detail: '没有物理网卡名' }
  }
  if (!Array.isArray(routes) || routes.length === 0) {
    return { ok: true, detail: '无基线路由，跳过' }
  }

  const commands = routes
    .filter(route => route.nextHop && route.nextHop !== '0.0.0.0')
    .map(route => `New-NetRoute -InterfaceAlias '${alias}' -DestinationPrefix '${route.destination}' -NextHop '${route.nextHop}' -RouteMetric ${route.metric || 0} -ErrorAction Stop`)
    .join('\n')

  if (commands === '') {
    return { ok: true, detail: '基线里没有可恢复的网关（原本就是 on-link）' }
  }

  const script = `
$ErrorActionPreference = 'Stop'
${commands}
Write-Output 'ok'
`
  const res = await shell(cfg, script)
  const out = String(res?.stdout ?? '')
  if (!res.ok || !out.includes('ok')) {
    return { ok: false, detail: (res?.stderr || out || 'needs elevation').slice(0, 200) }
  }
  return { ok: true, detail: `${alias} 的 ${routes.length} 条默认网关已恢复` }
}

/**
 * 恢复物理网卡默认路由的 metric。
 * @param {object} options
 * @param {object} options.cfg defaults.windows
 * @param {string} options.alias
 * @param {number} options.metric 基线 metric
 * @returns {Promise<{ok: boolean, detail: string}>}
 */
export async function restorePhysicalRouteMetric(options) {
  const { cfg, alias, metric } = options
  if (typeof alias !== 'string' || alias === '') {
    return { ok: false, detail: '没有物理网卡名' }
  }
  const script = `
$ErrorActionPreference = 'Stop'
$routes = Get-NetRoute -InterfaceAlias '${alias}' -DestinationPrefix '${cfg.defaultRoutePrefix}' -ErrorAction SilentlyContinue
if (-not $routes) { Write-Output 'no-route'; exit 0 }
foreach ($r in $routes) {
  Set-NetRoute -InterfaceIndex $r.InterfaceIndex -DestinationPrefix $r.DestinationPrefix -RouteMetric ${metric} -ErrorAction Stop
}
Write-Output 'ok'
`
  const result = await shell(cfg, script)
  const out = String(result?.stdout ?? '')
  if (!result.ok || !out.includes('ok')) {
    return { ok: false, detail: (result?.stderr || out || 'needs elevation').slice(0, 200) }
  }
  return { ok: true, detail: `${alias} 默认路由 metric 恢复为 ${metric}` }
}

/**
 * 读物理网卡当前默认路由的 metric（用于记录基线）。
 * @param {object} options
 * @returns {Promise<{ok: boolean, metric: number, detail: string}>}
 */
export function readPhysicalRouteMetric(options) {
  const { cfg, alias } = options
  if (typeof alias !== 'string' || alias === '') {
    return Promise.resolve({ ok: false, metric: 0, detail: '没有物理网卡名' })
  }
  const script = `
$r = Get-NetRoute -InterfaceAlias '${alias}' -DestinationPrefix '${cfg.defaultRoutePrefix}' -ErrorAction SilentlyContinue |
  Sort-Object RouteMetric | Select-Object -First 1
if ($r) { [string]$r.RouteMetric } else { '' }
`
  return shell(cfg, script).then((result) => {
    const raw = String(result?.stdout ?? '').trim()
    const metric = Number(raw)
    if (!Number.isFinite(metric)) return { ok: false, metric: 0, detail: `读不到（${raw || 'empty'}）` }
    return { ok: true, metric, detail: `${alias} 当前 metric=${metric}` }
  })
}
