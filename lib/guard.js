/**
 * 守卫核心：三段式切换、全链路加固、泄漏审计、真 IP 校准。
 *
 * 设计原则（写进代码也写进 UI）：
 *  1. **global 模式下不存在「部分代理」**。TUN 覆盖 L3，系统代理覆盖 WinINET，
 *     严格路由堵住绑物理网卡的应用，DNS 劫持堵住解析泄漏，IPv6 关断堵住 v6 旁路。
 *  2. **任何一项没做到就报红**，不降级成「大概没问题」。
 *  3. **真 IP 只在校准那一刻采一次**，之后每次审计都拿它当黑名单值比对。
 *
 * 本文件不出现任何字面量：模式映射来自 defaults.modes，加固项来自
 * defaults.harden / tun / dns，严重度来自 defaults.audit.severities，
 * TUN 网关从网卡实际 DNS 推导。
 *
 * @module dsh-clash-guard/guard
 */
import fs from 'node:fs'
import { getJson, request } from './mihomo.js'
import { takeSnapshot } from './snapshot.js'
import * as verge from './verge.js'
import * as win from './windows.js'
import { probeViaProxy, probeDirect } from './egress.js'
import {
  probeInterfaceBypass,
  probeSystemResolver,
  probeDefaultRoutes,
  probeMachineTraffic,
  raisePhysicalRouteMetric,
  restorePhysicalRouteMetric,
  readPhysicalRouteMetric,
} from './leaks.js'
import {
  applyInterfaceBlock,
  removeInterfaceBlock,
  inspectInterfaceBlock,
  resolveCorePath,
} from './firewall.js'
import { ensureDir, stateDir } from './paths.js'
import * as core from './core.js'

/* ------------------------------------------------------------------ *
 * 状态文件
 * ------------------------------------------------------------------ */

/**
 * 读插件状态（真 IP、上次加固结果）。
 * @param {object} paths {stateFile}
 */
export function readState(paths) {
  try {
    return JSON.parse(fs.readFileSync(paths.stateFile, 'utf8'))
  } catch {
    return {}
  }
}

/**
 * 写插件状态（合并 + 原子替换）。
 * @param {object} paths {stateFile}
 * @param {object} patch
 */
export function writeState(paths, patch) {
  const current = readState(paths)
  const next = { ...current, ...patch, updatedAt: Date.now() }
  try {
    ensureDir(stateDir())
    const temp = `${paths.stateFile}.tmp`
    fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    fs.renameSync(temp, paths.stateFile)
  } catch {
    // 状态文件写失败不影响主流程
  }
  return next
}

/* ------------------------------------------------------------------ *
 * 模式映射
 * ------------------------------------------------------------------ */

/**
 * 三段式开关 → 内核 mode。
 * @param {object} modes defaults.modes
 * @param {string} name
 */
export function coreModeOf(modes, name) {
  return Object.hasOwn(modes, name) ? modes[name] : ''
}

/**
 * 内核 mode → 三段式开关名。
 * @param {object} modes defaults.modes
 * @param {string} coreMode
 */
export function modeNameOf(modes, coreMode) {
  for (const [name, value] of Object.entries(modes)) {
    if (value === coreMode) return name
  }
  return coreMode
}

/* ------------------------------------------------------------------ *
 * 加固 / 撤销
 * ------------------------------------------------------------------ */

/**
 * 推导 TUN 网关地址：取 TUN 网卡实际配置的 DNS。
 * 不硬编码 198.18.0.2——那是 mihomo 默认值，用户可能改过。
 * @param {object} config
 * @returns {Promise<string>}
 */
async function resolveTunGateway(config) {
  const tun = await win.readTunDns(config.windows, config.discovery)
  if (tun.servers.length > 0) return tun.servers[0]
  return ''
}

/**
 * 把 TUN 段的补丁值写进运行配置文件。
 *
 * `PATCH /configs` 只改运行时；内核重启会按文件重建，所以文件必须同步。
 *
 * @param {object} options
 * @param {object} options.target
 * @param {object} options.config
 * @param {object} options.tunPatch 要写进去的键值（camelCase 见 config.tun 映射）
 * @returns {{ok: boolean, changed: boolean, detail: string}}
 */
function persistTun(options) {
  const { target, config, tunPatch } = options
  const runtimeDirs = Array.isArray(target.runtimeDirs) ? target.runtimeDirs : []
  if (runtimeDirs.length === 0) return { ok: false, changed: false, detail: '无运行配置目录' }

  const file = `${runtimeDirs[0]}\\${config.discovery.runtimeConfigName}`
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    return { ok: false, changed: false, detail: `读失败: ${error.message}` }
  }

  const usesCrlf = raw.includes('\r\n')
  let text = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  let touched = false

  // JSON 键名 → YAML 里就是同一个名字（mihomo 的 tunSchema 两边一致）
  for (const [key, value] of Object.entries(tunPatch)) {
    const literal = typeof value === 'boolean' ? String(value) : String(value)
    const edit = setBlockScalar(text, 'tun', key, literal)
    if (edit.ok) {
      text = edit.text
      if (edit.changed) touched = true
    }
  }

  // strict-route 单独处理：只有当 hardenCfg 要求时才写 true
  if (config.harden.strictRoute) {
    const edit = setBlockScalar(text, 'tun', 'strict-route', 'true')
    if (edit.ok) {
      text = edit.text
      if (edit.changed) touched = true
    }
  }

  if (!touched) return { ok: true, changed: false, detail: 'already' }

  const finalText = usesCrlf ? text.replace(/\n/g, '\r\n') : text
  try {
    fs.writeFileSync(`${file}${config.verge.backupSuffix}`, raw, 'utf8')
    const temp = `${file}${config.verge.tempSuffix}`
    fs.writeFileSync(temp, finalText, 'utf8')
    fs.renameSync(temp, file)
    return { ok: true, changed: true, detail: 'written' }
  } catch (error) {
    return { ok: false, changed: false, detail: error.message }
  }
}

/**
 * 定向改写 YAML 里某个块下的标量。
 *
 * 只改那一行，其余逐字保留 —— Clash Verge 的配置有几千行规则，
 * 任何一次整份重排都会引入格式漂移，也会让用户的 diff 全红。
 *
 * @param {string} text 原始 YAML（已规范化 LF）
 * @param {string} block 顶层块名
 * @param {string} key 块内键名
 * @param {string} value 目标值（会按需加引号）
 * @returns {{ok: boolean, text: string, changed: boolean}}
 */
function setBlockScalar(text, block, key, value) {
  const lines = text.split('\n')
  const blockRe = new RegExp(`^${block.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*$`)
  const start = lines.findIndex(line => blockRe.test(line))
  if (start < 0) return { ok: false, text, changed: false }

  const keyRe = new RegExp(`^(\\s+)${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*(.*)$`)
  for (let i = start + 1; i < lines.length; i += 1) {
    // 回到顶层就说明块结束了
    if (/^\S/.test(lines[i]) && lines[i].trim() !== '') break
    const hit = keyRe.exec(lines[i])
    if (hit === null) continue
    const indent = hit[1]
    const next = `${indent}${key}: ${value}`
    if (lines[i] === next) return { ok: true, text, changed: false }
    lines[i] = next
    return { ok: true, text: lines.join('\n'), changed: true }
  }
  return { ok: false, text, changed: false }
}

/**
 * 让 DNS 加固真正生效。
 *
 * 路径：改运行配置文件里的 dns 段 → `PUT /configs` 整份重载。
 *
 * @param {object} options
 * @param {object} options.target
 * @param {object} options.config
 * @returns {Promise<{ok: boolean, detail: string}>}
 */
async function hardenDns(options) {
  const { target, config } = options
  const dnsCfg = config.dns
  const runtimeDirs = Array.isArray(target.runtimeDirs) ? target.runtimeDirs : []
  if (runtimeDirs.length === 0) {
    return { ok: false, detail: '没有运行配置目录，无法改写 DNS（PATCH 不支持 dns 段）' }
  }

  const file = `${runtimeDirs[0]}\\${config.discovery.runtimeConfigName}`
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    return { ok: false, detail: `读运行配置失败：${error.message}` }
  }

  const usesCrlf = raw.includes('\r\n')
  let text = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n')

  // enable / enhanced-mode
  const wantEnable = dnsCfg.enable === true ? 'true' : 'false'
  const enableEdit = setBlockScalar(text, 'dns', 'enable', wantEnable)
  if (!enableEdit.ok) return { ok: false, detail: '配置文件里找不到 dns.enable' }
  text = enableEdit.text

  const modeEdit = setBlockScalar(text, 'dns', 'enhanced-mode', dnsCfg.enhancedMode)
  if (!modeEdit.ok) return { ok: false, detail: '配置文件里找不到 dns.enhanced-mode' }
  text = modeEdit.text

  const changed = enableEdit.changed || modeEdit.changed

  if (changed) {
    const finalText = usesCrlf ? text.replace(/\n/g, '\r\n') : text
    try {
      fs.writeFileSync(`${file}${config.verge.backupSuffix}`, raw, 'utf8')
      const temp = `${file}${config.verge.tempSuffix}`
      fs.writeFileSync(temp, finalText, 'utf8')
      fs.renameSync(temp, file)
    } catch (error) {
      return { ok: false, detail: `写运行配置失败：${error.message}` }
    }
  }

  // 整份重载：payload 非空 → ParseWithBytes 重建全部配置
  const reload = await request(target, 'PUT', '/configs?force=true', {
    path: '',
    payload: text,
  })
  if (!reload.ok) {
    return {
      ok: false,
      detail: `配置已改但重载失败：${reload.status || reload.error} ${String(reload.text).slice(0, 120)}`,
    }
  }

  // 回读校验：DNS 是否真的活了（用 /dns/query 探一次）
  try {
    const probe = await getJson(
      target,
      `/dns/query?name=${encodeURIComponent(config.leaks.dnsProbeName)}&type=A`,
    )
    const answers = Array.isArray(probe?.Answer) ? probe.Answer.length : 0
    return {
      ok: true,
      detail: `${dnsCfg.enhancedMode} 已写入并重载${changed ? '' : '（值本就正确）'}；`
        + `/dns/query 回 ${answers} 条答复（DNS 模块存活）`,
    }
  } catch (error) {
    return {
      ok: false,
      detail: `已重载但 DNS 模块仍不可用：${String(error.message ?? error).slice(0, 120)}`,
    }
  }
}

/**
 * 应用加固：把 global 模式下所有已知泄漏面关掉。
 *
 * @param {object} options
 * @param {object} options.target 控制器目标
 * @param {object} options.config 完整配置
 * @param {object} options.paths {stateFile}
 * @returns {Promise<Array<{step: string, ok: boolean, detail: string}>>}
 */
export async function harden(options) {
  const { target, config, paths } = options
  const { tun: tunCfg, dns: dnsCfg, harden: hardenCfg, windows: winCfg, discovery } = config
  const steps = []

  // 0. **记录系统原始状态**（只在没有基线时记录一次）。
  //
  //    撤销时按这份基线恢复。两条纪律：
  //    - 不记录就假设「原本是开的」，会把用户原本关着的 IPv6 打开——反向改动；
  //    - **不能每次加固都覆盖基线**，否则 global → global 会把「已加固」当成
  //      「原始」，撤销后停在加固态。基线由 unharden 清空，所以一轮加固-撤销
  //      对应一份基线。
  const existing = paths === undefined ? {} : readState(paths)
  const pre = await win.readIpv6State(winCfg, discovery)
  const preDnsList = await win.readDnsServers(winCfg)
  const prePhysDns = preDnsList.find(d => d.alias === pre.physicalAdapter)
  const preSp = await win.readSystemProxy(winCfg)
  const preWh = await win.readWinHttpProxy(winCfg)

  if (existing.baseline === undefined || existing.baseline === null) {
    if (paths !== undefined) {
      writeState(paths, {
        baseline: {
          at: Date.now(),
          physicalAdapter: pre.physicalAdapter,
          ipv6Bound: pre.ipv6Bound,
          dns: prePhysDns === undefined ? [] : prePhysDns.v4,
          systemProxy: { enabled: preSp.enabled, server: preSp.server, override: preSp.override },
          winhttpConfigured: preWh.configured,
        },
      })
    }
    steps.push({
      step: 'baseline',
      ok: true,
      detail: `记录原始状态：${pre.physicalAdapter || '(none)'} ipv6=${pre.ipv6Bound} `
        + `dns=[${prePhysDns === undefined ? '' : prePhysDns.v4.join(',')}] `
        + `wininet=${preSp.enabled} winhttp=${preWh.configured}`,
    })
  } else {
    steps.push({
      step: 'baseline',
      ok: true,
      detail: `沿用已有基线（${new Date(existing.baseline.at).toISOString()}）：`
        + `ipv6=${existing.baseline.ipv6Bound} dns=[${(existing.baseline.dns ?? []).join(',')}]`,
    })
  }

  // 1. TUN + 自动路由 + 严格路由
  // 1. TUN + 自动路由 + 严格路由
  //
  // 双管齐下，因为两者解决的是不同问题：
  //   · `PATCH /configs` 改**运行时**（立刻生效，但配置文件不变）；
  //   · 写配置文件    保证**重启后仍然是这个值**（否则内核一重启就回退）。
  //
  // 实测教训：只做 PATCH 时，后来一次 PUT 重载会用文件里的旧值把 strict-route
  // 又改回 false —— 「改过了」和「留下了」是两件事。
  const tunPatch = {
    enable: tunCfg.enable,
    'auto-route': tunCfg.autoRoute,
    'auto-detect-interface': tunCfg.autoDetectInterface,
  }
  if (tunCfg.stack !== '') tunPatch.stack = tunCfg.stack
  if (hardenCfg.strictRoute) tunPatch['strict-route'] = true
  const tunRes = await request(target, 'PATCH', '/configs', { tun: tunPatch })

  // 同步写文件
  const tunPersist = persistTun({ target, config, tunPatch })

  steps.push({
    step: 'tun',
    ok: tunRes.ok,
    detail: tunRes.ok
      ? `TUN on, auto-route on${hardenCfg.strictRoute ? ', strict-route on' : ''}`
        + `；文件${tunPersist.ok ? (tunPersist.changed ? '已同步' : '本就一致') : `写入失败(${tunPersist.detail})`}`
      : `${tunRes.status || tunRes.error}: ${String(tunRes.text).slice(0, 160)}`,
  })

  // 2. DNS：fake-ip + 劫持
  //
  // **不能用 PATCH /configs**。实测（mihomo v1.19.33 源码 + 真机）：
  // `patchConfigs` 的 `configSchema` 里根本没有 `dns` 字段，`getConfigs`
  // 也不返回它。发过去返回 204，但值被静默丢弃 —— 一个「看起来成功、
  // 实际什么都没做」的假动作，比报错更危险。
  //
  // 真做法：改配置文件 + PUT /configs 整份重载。
  //   · PUT { path, payload } 的 payload 非空 → ParseWithBytes 整份重建；
  //   · 配置文件里已经有完整 dns 段，只需把目标键改对，再整份送回去。
  const dnsRes = await hardenDns({ target, config })
  steps.push({ step: 'dns', ok: dnsRes.ok, detail: dnsRes.detail })

  // 3. GLOBAL 组不能是 DIRECT / REJECT
  try {
    const groupName = config.bypass.selectorGroup
    const group = await getJson(target, `/proxies/${encodeURIComponent(groupName)}`)
    const bad = config.bypass.terminalNames.includes(group.now)
    steps.push({
      step: 'global-selector',
      ok: !bad,
      detail: bad
        ? `${groupName} 当前是 ${group.now} —— 这是全量泄漏`
        : `${groupName} -> ${group.now}`,
    })
  } catch (error) {
    steps.push({ step: 'global-selector', ok: false, detail: String(error.message ?? error) })
  }

  // 4. **断开所有既有连接** —— 渗透场景的关键一步。
  //    切换前建立的连接仍绑着旧路由（实测 11/31 条走 DIRECT），不清掉就等于
  //    「我以为走代理了，但那条 SSH / 那个扫描器还在用真实 IP」。
  if (hardenCfg.closeConnections) {
    const closed = await request(target, 'DELETE', '/connections')
    steps.push({
      step: 'close-connections',
      ok: closed.ok,
      detail: closed.ok ? '已断开全部旧连接，新连接按 global 路由' : `${closed.status || closed.error}`,
    })
  }

  // 5. 系统代理（双保险：不吃 TUN 的应用走 WinINET）
  const proxyAddr = `${config.egress.proxyHost}:${target.mixedPort}`
  if (hardenCfg.systemProxy) {
    const bypass = config.bypass?.loopback?.join(';') ?? ''
    const on = await win.setSystemProxy(winCfg, proxyAddr, bypass)
    steps.push({
      step: 'system-proxy',
      ok: on.ok,
      detail: on.ok ? `WinINET -> ${proxyAddr}` : (on.error ?? 'failed'),
    })
  }
  if (hardenCfg.winHttpProxy) {
    const wh = await win.setWinHttpProxy(winCfg, proxyAddr)
    steps.push({
      step: 'winhttp-proxy',
      ok: wh.ok,
      detail: wh.ok ? `WinHTTP -> ${proxyAddr}` : (wh.error ?? '需要管理员权限'),
    })
  }

  // 5. DoH 自动升级必须关：否则 Windows 把 DNS 升到 443，劫持 any:53 拦不住
  if (hardenCfg.disableAutoDoh) {
    const doh = await win.readDohState(winCfg)
    if (doh.autoDoh !== 0) {
      const off = await win.disableAutoDoh(winCfg)
      steps.push({
        step: 'auto-doh',
        ok: off.ok,
        detail: off.ok ? `${winCfg.autoDohValue}=0` : (off.error ?? '需要管理员权限'),
      })
    } else {
      steps.push({ step: 'auto-doh', ok: true, detail: `${winCfg.autoDohValue} already 0` })
    }
  }

  // 6. 物理网卡 IPv6 关断（v6 旁路是最常见的「我以为走代理了」翻车点）
  if (hardenCfg.disableIpv6) {
    if (!pre.resolvable) {
      steps.push({ step: 'ipv6', ok: false, detail: '找不到物理网卡' })
    } else if (!pre.ipv6Bound) {
      steps.push({ step: 'ipv6', ok: true, detail: `${pre.physicalAdapter} already unbound` })
    } else {
      const off = await win.disablePhysicalIpv6(winCfg, pre.physicalAdapter)
      steps.push({
        step: 'ipv6',
        ok: off.ok,
        detail: off.ok ? `${pre.physicalAdapter} ${winCfg.ipv6ComponentId} 已禁用` : (off.error ?? '需要管理员权限'),
      })
    }
  }

  // 7. 物理网卡 DNS 指向 TUN 网关（地址从网卡实际配置推导，不硬编码）
  if (hardenCfg.pointDns) {
    const gateway = await resolveTunGateway(config)
    if (!pre.resolvable) {
      steps.push({ step: 'dns-route', ok: false, detail: '找不到物理网卡' })
    } else if (gateway === '') {
      steps.push({ step: 'dns-route', ok: false, detail: 'TUN 网卡的 DNS 读不到，跳过' })
    } else {
      const res = await win.pointDns(winCfg, pre.physicalAdapter, gateway)
      steps.push({
        step: 'dns-route',
        ok: res.ok,
        detail: res.ok ? `${pre.physicalAdapter} DNS -> ${gateway}` : (res.error ?? '需要管理员权限'),
      })
    }
  }

  // 8. **接口级出站封锁** —— 唯一真正堵住「绑卡直连」的手段。
  //
  // 三次实测的结论：
  //   · `strict-route: true`      → 写进配置和文件都不生效
  //   · 抬高物理网卡路由 metric   → 路由表变 tun-wins，绑卡仍直连
  //   · 摘掉物理网卡默认网关      → 绑卡堵住了，但 mihomo 自己也断
  //
  // 根因：Windows 的 `bind()` 到源 IP 会强制走该接口，无视路由表；
  // 而 mihomo 连节点必须从物理网卡出去，所以不能靠路由区分「谁在用」。
  // 唯一能按进程区分的是防火墙（WFP，在路由之上）。
  if (hardenCfg.blockInterfaceEgress) {
    if (!pre.resolvable) {
      steps.push({ step: 'block-egress', ok: false, detail: '找不到物理网卡' })
    } else {
      const corePath = resolveCorePath({ discovered: options.discovered })
      if (corePath === '') {
        steps.push({ step: 'block-egress', ok: false, detail: '找不到内核可执行路径，无法放行' })
      } else {
        const applied = await applyInterfaceBlock({
          cfg: winCfg,
          rules: config.firewall,
          alias: pre.physicalAdapter,
          corePath,
        })
        steps.push({
          step: 'block-egress',
          ok: applied.ok,
          detail: applied.detail,
        })
        if (!applied.ok) {
          // 建规则失败必须确保没留半条，否则可能断网
          await removeInterfaceBlock({ cfg: winCfg, rules: config.firewall }).catch(() => {})
        }
      }
    }
  }

  return steps
}

/**
 * 撤销加固：**按加固前记录的基线**恢复，而不是假设「原本都是开的」。
 *
 * 用户原本关着 IPv6，撤销后必须是关着的；原本 DNS 是 ISP 给的，撤销后必须
 * 回到那台服务器。没有基线（插件装好前就已经开着 global）时只做保守恢复：
 * 关系统代理、WinHTTP 直连、DNS 回自动，IPv6 不动。
 *
 * **关闭模式必须连 TUN 一起关**：TUN 还在接管 L3，mode=direct 只是让规则
 * 放行，流量仍从 TUN 出去——那是「假关闭」，比不关更危险。
 *
 * @param {object} config
 * @param {object} [paths] {stateFile}
 * @param {object} [target] 控制器目标；给了就顺手关 TUN
 */
export async function unharden(config, paths, target) {
  const { harden: hardenCfg, windows: winCfg, discovery } = config
  const steps = []
  const state = paths === undefined ? {} : readState(paths)
  const baseline = state.baseline ?? null

  // 0. 关 TUN：不关就是假关闭
  if (target !== undefined) {
    const tunOff = await request(target, 'PATCH', '/configs', { tun: { enable: false } })
    steps.push({
      step: 'tun-off',
      ok: tunOff.ok,
      detail: tunOff.ok ? 'TUN 已关闭，流量不再被接管' : `${tunOff.status || tunOff.error}`,
    })
    // 关 TUN 后旧连接全部失效，清一次表确保没有残留
    if (hardenCfg.closeConnections) {
      const closed = await request(target, 'DELETE', '/connections')
      steps.push({
        step: 'close-connections',
        ok: closed.ok,
        detail: closed.ok ? '已清空连接表' : `${closed.status || closed.error}`,
      })
    }
  }

  // 系统代理：基线里原本是开的就恢复成原来的地址，原本关着就关掉
  if (hardenCfg.systemProxy) {
    if (baseline !== null && baseline.systemProxy?.enabled === true && baseline.systemProxy.server) {
      const restore = await win.setSystemProxy(winCfg, baseline.systemProxy.server, baseline.systemProxy.override ?? '')
      steps.push({
        step: 'system-proxy',
        ok: restore.ok,
        detail: restore.ok
          ? `WinINET -> ${baseline.systemProxy.server}（基线值）`
          : (restore.error ?? 'failed'),
      })
    } else {
      const sp = await win.clearSystemProxy(winCfg)
      steps.push({ step: 'system-proxy', ok: sp.ok, detail: sp.ok ? 'WinINET 系统代理已关闭' : (sp.error ?? 'failed') })
    }
  }

  // WinHTTP：基线里原本配着就恢复，原本是直连就 reset
  if (hardenCfg.winHttpProxy) {
    if (baseline !== null && baseline.winhttpConfigured === true && baseline.systemProxy?.server) {
      const wh = await win.setWinHttpProxy(winCfg, baseline.systemProxy.server)
      steps.push({
        step: 'winhttp-proxy',
        ok: wh.ok,
        detail: wh.ok ? `WinHTTP -> ${baseline.systemProxy.server}（基线值）` : (wh.error ?? '需要管理员权限'),
      })
    } else {
      const wh = await win.resetWinHttpProxy(winCfg)
      steps.push({ step: 'winhttp-proxy', ok: wh.ok, detail: wh.ok ? 'WinHTTP 已恢复直连' : (wh.error ?? '需要管理员权限') })
    }
  }

  const v6 = await win.readIpv6State(winCfg, discovery)
  if (!v6.resolvable) return steps

  // IPv6：按基线恢复；没有基线就不动（保守），并说明原因
  if (baseline === null) {
    steps.push({
      step: 'ipv6',
      ok: true,
      detail: `无基线记录，IPv6 保持当前值（${v6.ipv6Bound ? 'bound' : 'unbound'}），未做改动`,
    })
  } else if (baseline.ipv6Bound === v6.ipv6Bound) {
    steps.push({ step: 'ipv6', ok: true, detail: `已是基线值（${baseline.ipv6Bound ? 'bound' : 'unbound'}）` })
  } else if (baseline.ipv6Bound === true) {
    const on = await win.enablePhysicalIpv6(winCfg, v6.physicalAdapter)
    steps.push({
      step: 'ipv6',
      ok: on.ok,
      detail: on.ok ? `${v6.physicalAdapter} ${winCfg.ipv6ComponentId} 已恢复` : (on.error ?? '需要管理员权限'),
    })
  } else {
    const off = await win.disablePhysicalIpv6(winCfg, v6.physicalAdapter)
    steps.push({
      step: 'ipv6',
      ok: off.ok,
      detail: off.ok ? `${v6.physicalAdapter} ${winCfg.ipv6ComponentId} 已恢复（关闭态）` : (off.error ?? '需要管理员权限'),
    })
  }

  // DNS：按基线恢复
  if (baseline === null) {
    const dns = await win.resetDns(winCfg, v6.physicalAdapter)
    steps.push({
      step: 'dns-route',
      ok: dns.ok,
      detail: dns.ok ? `${v6.physicalAdapter} DNS reset (no baseline)` : (dns.error ?? '需要管理员权限'),
    })
  } else if (!Array.isArray(baseline.dns) || baseline.dns.length === 0) {
    const dns = await win.resetDns(winCfg, v6.physicalAdapter)
    steps.push({
      step: 'dns-route',
      ok: dns.ok,
      detail: dns.ok ? `${v6.physicalAdapter} DNS 回自动获取（基线为空）` : (dns.error ?? '需要管理员权限'),
    })
  } else {
    const dns = await win.pointDns(winCfg, v6.physicalAdapter, baseline.dns[0])
    steps.push({
      step: 'dns-route',
      ok: dns.ok,
      detail: dns.ok ? `${v6.physicalAdapter} DNS -> ${baseline.dns[0]}（基线值）` : (dns.error ?? '需要管理员权限'),
    })
  }

  // 路由 metric：按基线还原（否则关了代理仍上不了网，因为 metric 还压着）
  if (hardenCfg.raiseRouteMetric) {
    const metricBaseline = state.routeMetricBaseline ?? null
    if (metricBaseline === null) {
      steps.push({ step: 'route-metric', ok: true, detail: '无 metric 基线，保持当前值' })
    } else {
      const restored = await restorePhysicalRouteMetric({
        cfg: winCfg,
        alias: metricBaseline.alias,
        metric: metricBaseline.metric,
      })
      steps.push({
        step: 'route-metric',
        ok: restored.ok,
        detail: restored.ok
          ? `${metricBaseline.alias} metric 恢复为 ${metricBaseline.metric}`
          : (restored.detail ?? '需要管理员权限'),
      })
    }
  }

  // 接口级出站封锁：删掉自己建的规则（按固定前缀，不碰用户规则）
  if (hardenCfg.blockInterfaceEgress) {
    const removed = await removeInterfaceBlock({ cfg: winCfg, rules: config.firewall })
    steps.push({
      step: 'block-egress',
      ok: removed.ok,
      detail: removed.ok ? removed.detail : (removed.detail ?? '需要管理员权限'),
    })
  }

  // 一轮加固-撤销结束，清空基线：下一次切 global 会重新采一份，
  // 不会把这次加固后的状态当成「原始」。
  if (paths !== undefined) {
    const next = { ...state }
    delete next.baseline
    delete next.routeMetricBaseline
    try {
      const temp = `${paths.stateFile}.tmp`
      fs.writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
      fs.renameSync(temp, paths.stateFile)
    } catch { /* 状态文件写失败不影响撤销 */ }
  }

  return steps
}

/* ------------------------------------------------------------------ *
 * 泄漏审计
 * ------------------------------------------------------------------ */

/**
 * 把字段来源翻成中文。
 *
 * `snapshot.sources` 里存的是 `api` / `file` / `missing` —— 那是内部标识，
 * 显示时要说人话。这个函数只做呈现，不改数据。
 *
 * @param {string} source
 * @returns {string}
 */
export function sourceLabel(source) {
  const map = { api: '运行时', file: '配置文件', missing: '缺失' }
  return map[source] ?? String(source ?? '')
}

/**
 * 泄漏审计。每一条都是可判定的事实，不是猜测。
 *
 * @param {object} options
 * @param {object} options.target
 * @param {object} options.config
 * @param {object} options.paths {stateFile}
 * @returns {Promise<{verdict: string, checks: Array<object>, snapshot: object}>}
 */
export async function audit(options) {
  const { target, config, paths } = options
  const { audit: auditCfg, windows: winCfg, discovery, modes, egress } = config
  const sev = auditCfg.severities
  const checks = []
  const add = (id, ok, title, detail) => {
    checks.push({ id, severity: sev[id] ?? 'medium', ok: ok === true, title, detail: String(detail ?? '') })
  }

  const cfg = await takeSnapshot({ target, config })
  const mode = String(cfg.mode ?? '')
  const name = modeNameOf(modes, mode)

  // —— 基础配置 ——
  add('mode', mode === modes.global, '内核处于全局模式',
    mode === modes.global ? `mode=${mode}` : `mode=${mode}（规则模式下 CN 域名走 DIRECT，等于直连暴露）`)

  add('tun', cfg.tun.enable === true, 'TUN 已开启',
    cfg.tun.enable === true
      ? `协议栈=${cfg.tun.stack ?? "?"}，自动路由=${cfg.tun.autoRoute ? "开" : "关"}, 来源=${sourceLabel(cfg.sources["tun.enable"])}`
      : 'TUN 关闭，不吃系统代理的应用会直连')

  add('auto-route', cfg.tun.autoRoute === true, 'TUN 自动路由已开启',
    cfg.tun.autoRoute === true ? 'auto-route=true' : 'auto-route=false，默认路由不进 TUN')

  add('strict-route', cfg.tun.strictRoute === true, 'TUN 严格路由已开启',
    cfg.tun.strictRoute === true
      ? 'strict-route=true'
      : `strict-route=${cfg.tun.strictRoute}（来源=${sourceLabel(cfg.sources["tun.strict-route"])}）：绑定物理网卡的应用可以绕过 TUN，渗透场景建议开`)

  add('dns-fakeip', cfg.dns.enable === true && cfg.dns.enhancedMode === config.dns.enhancedMode,
    'DNS fake-ip 已开启',
    `enable=${cfg.dns.enable}, enhanced-mode=${cfg.dns.enhancedMode}, 来源=${sourceLabel(cfg.sources["dns.enable"])}`)

  const hijack = Array.isArray(cfg.dns.hijack) ? cfg.dns.hijack : []
  const wantHijack = config.dns.hijack
  add('dns-hijack', wantHijack.every(h => hijack.includes(h)), 'DNS 劫持覆盖全部网段',
    hijack.length === 0 ? '未配置 dns-hijack' : hijack.join(', '))

  // —— 控制器 secret 是否还是出厂默认 ——
  // Clash Verge Rev 的默认 secret 是 `set-your-secret`（官方讨论 #6951 确认）。
  // 管道模式下无鉴权面，但用户一旦打开 TCP external-controller，默认密钥
  // 等于把控制面（改模式/改节点/改配置）暴露给本机任何进程。
  add('controller-secret', cfg.secret !== '' && cfg.secret !== 'set-your-secret',
    '控制器密钥不是出厂默认值',
    cfg.secret === ''
      ? '未设置 secret（管道模式无鉴权面，可接受；若启用 TCP external-controller 必须设置）'
      : (cfg.secret === 'set-your-secret'
        ? 'secret 仍是出厂默认值 —— 一旦开 TCP external-controller，本机任意进程都能控制内核'
        : '已自定义'))


  // —— GLOBAL 组 ——
  const selectorGroup = config.bypass.selectorGroup
  const terminalNames = config.bypass.terminalNames
  let globalNow = ''
  try {
    const group = await getJson(target, `/proxies/${encodeURIComponent(selectorGroup)}`)
    globalNow = String(group.now ?? '')
    const bad = terminalNames.includes(globalNow)
    add('global-selector', !bad, `${selectorGroup} 出口不是直连/拒绝`,
      bad ? `${selectorGroup}=${globalNow} —— 全局模式下等于全量直连` : `${selectorGroup}=${globalNow}`)
  } catch (error) {
    add('global-selector', false, `${selectorGroup} 出口可读`, String(error.message ?? error))
  }

  // —— 活连接里不能有 DIRECT ——
  // 同时把按进程的明细算出来：下面 process-direct 与这里共用一次 /connections。
  let directCount = 0
  let total = 0
  let processLeaks = { ok: false, total: 0, direct: [], hasDirect: false, detail: '/connections 不可读' }
  try {
    const conns = await getJson(target, '/connections')
    const list = Array.isArray(conns?.connections) ? conns.connections : []
    total = list.length
    const perProcess = new Map()
    for (const conn of list) {
      const chains = Array.isArray(conn.chains) ? conn.chains : []
      const directOnly = chains.length === 1 && terminalNames.includes(chains[0])
      if (directOnly) {
        directCount += 1
        const meta = conn.metadata ?? {}
        const proc = String(meta.process ?? '').trim() || '(未知进程)'
        if (!perProcess.has(proc)) perProcess.set(proc, { process: proc, direct: 0, total: 0, hosts: new Set() })
        const row = perProcess.get(proc)
        row.direct += 1
        const host = String(meta.host ?? meta.destinationIP ?? '').trim()
        if (host !== '' && row.hosts.size < 5) row.hosts.add(host)
      }
      // 顺带统计每个进程的总连接数
      const meta = conn.metadata ?? {}
      const proc = String(meta.process ?? '').trim() || '(未知进程)'
      if (!perProcess.has(proc)) perProcess.set(proc, { process: proc, direct: 0, total: 0, hosts: new Set() })
      perProcess.get(proc).total += 1
    }
    const directRows = [...perProcess.values()]
      .filter(row => row.direct > 0)
      .map(row => ({ process: row.process, direct: row.direct, total: row.total, hosts: [...row.hosts] }))
      .sort((a, b) => b.direct - a.direct)
    processLeaks = {
      ok: true,
      total: list.length,
      direct: directRows,
      hasDirect: directRows.length > 0,
      detail: directRows.length === 0
        ? `${list.length} 条连接中没有直连`
        : `${directRows.length} 个进程在直连：${directRows.slice(0, 4).map(r => `${r.process}(${r.direct}/${r.total})`).join(', ')}`,
    }
    add('live-direct', mode !== modes.global || directCount === 0,
      'global 模式下没有直连活连接',
      mode !== modes.global
        ? `当前非 global，跳过（${total} 条连接）`
        : directCount === 0
          ? `${total} 条连接全部经代理`
          : `${directCount}/${total} 条连接直连 —— 真实 IP 正在暴露。切换到 global 会断开全部旧连接，请重新切换一次`)
  } catch (error) {
    add('live-direct', false, '连接表可读', String(error.message ?? error))
  }

  // —— 按进程点名 ——
  add('process-direct', mode !== modes.global || !processLeaks.hasDirect,
    'global 模式下没有进程直连',
    mode !== modes.global
      ? `当前非 global，跳过（${processLeaks.total} 条连接）`
      : processLeaks.detail)

  // —— 物理网卡自己的地址（供旁路探针用；注意不是 DNS 地址）——
  const v6 = await win.readIpv6State(winCfg, discovery)
  const adapterAddr = await win.readAdapterAddresses(winCfg, discovery, v6.physicalAdapter)

  // —— 物理网卡旁路（strict-route 的真实效果）——
  // 不读配置值，直接试：绑物理网卡能不能连出去。
  // 配置写 strict-route:true 但实际能连，那就是「写了没生效」，比没写更危险。
  {
    const bypass = await probeInterfaceBypass({ localAddress: adapterAddr.primary, config })
    add('interface-bypass', bypass.ok === true,
      '物理网卡无法绕过 TUN',
      bypass.state === 'unknown' ? `无法判定：${bypass.detail}` : bypass.detail)
  }

  // —— 默认路由竞争 ——
  // 实测发现的最隐蔽一条：物理网卡与 TUN 的 0.0.0.0/0 metric 相同，
  // 选路不确定，绑网卡的流量能真的直连出去 —— 而 strict-route: true
  // 写进配置也没解决它。所以必须看路由表，不能只看配置。
  {
    const routes = await probeDefaultRoutes({ cfg: winCfg, tunPatterns: discovery.tunAdapterPatterns })
    add('default-routes', routes.ok === true,
      '默认路由由 TUN 独占',
      routes.detail)
  }

  // —— 整机连接审计 ——
  // 这条看的是 Windows 自己的连接表，不是 mihomo 的 /connections：
  // 绑物理网卡的程序根本不进 mihomo，只有这里能点名它。
  // mihomo 自己连节点的连接按进程名排除 —— 隧道从物理网卡出去是天经地义的。
  {
    const machine = await probeMachineTraffic({ config, physicalIp: adapterAddr.primary })
    add('machine-traffic', machine.ok === true && machine.directTotal === 0,
      '整机没有绕过代理的直连 TCP 连接',
      machine.ok === true ? machine.detail : `无法枚举：${machine.detail}`)
  }

  // —— 系统解析器是否走 fake-ip ——
  // 与 dns-fakeip 的区别：那条看「配置开没开」，这条看「系统实际解析成了什么」。
  {
    const resolver = await probeSystemResolver({ config })
    add('system-resolver', resolver.ok === true, '系统解析走 fake-ip', resolver.detail)
  }

  // —— 出口 IP vs 校准真 IP ——
  const state = readState(paths)
  const realIp = typeof state.realIp === 'string' && state.realIp !== '' ? state.realIp : null
  const egressResult = await probeViaProxy({ mixedPort: target.mixedPort, egress, proxyHost: egress.proxyHost })
  add('egress', egressResult.ok === true, '代理出口可用',
    egressResult.ok === true
      ? `${egressResult.ip}（via ${egressResult.via}）`
      : `所有探测端点失败：${egressResult.attempts.map(a => a.error ?? a.status).join(' / ')}`)

  if (realIp !== null && egressResult.ok === true) {
    const same = egressResult.ip === realIp
    add('egress-vs-real', !same, '出口 IP 不等于校准的真 IP',
      same ? `出口 ${egressResult.ip} == 真 IP —— 代理没生效` : `出口 ${egressResult.ip} != 真 IP ${realIp}`)
  } else if (realIp === null) {
    add('egress-vs-real', false, '尚未校准真 IP',
      '在「关闭」状态点一次「校准真 IP」，之后每次审计都会拿它比对')
  }

  // —— 物理网卡旁路在 v6 之后已算过（见上方 process-direct 之后）——

  // —— 系统代理（非 critical：TUN 已覆盖，但双保险）——
  const sp = await win.readSystemProxy(winCfg)
  const proxyOk = sp.enabled && sp.server.includes(`:${target.mixedPort}`)
  add('system-proxy', proxyOk, 'WinINET 系统代理指向混合端口',
    proxyOk ? sp.server : `enabled=${sp.enabled}, server=${sp.server || '(空)'}`)

  const wh = await win.readWinHttpProxy(winCfg)
  add('winhttp', wh.configured, 'WinHTTP 代理已设置',
    wh.configured ? 'configured' : 'Direct access（部分服务/后台进程不受 WinINET 影响）')

  // —— DoH ——
  const doh = await win.readDohState(winCfg)
  add('auto-doh', doh.autoDoh === 0, 'DoH 自动升级已关闭',
    doh.autoDoh === 0 ? `${winCfg.autoDohValue}=0` : `${winCfg.autoDohValue}=${doh.autoDoh}：Windows 会把 DNS 升到 443，绕过 any:53 劫持`)

  // —— IPv6 ——（v6 已在上面算过，直接复用）
  add('ipv6', !v6.ipv6Bound && v6.globalAddresses.length === 0, '物理网卡 IPv6 已关断',
    v6.ipv6Bound
      ? `${v6.physicalAdapter} ${winCfg.ipv6ComponentId} 仍启用${v6.globalAddresses.length > 0 ? `，全局地址 ${v6.globalAddresses.join(',')}` : ''}`
      : `${v6.physicalAdapter || '(none)'} IPv6 unbound`)

  // —— DNS 解析器 ——
  const dnsList = await win.readDnsServers(winCfg)
  const physDns = dnsList.find(d => d.alias === v6.physicalAdapter)
  const gateway = await resolveTunGateway(config)
  const dnsOk = physDns === undefined
    || gateway === ''
    || physDns.v4.every(s => s === gateway)
  add('dns-resolver', dnsOk, '物理网卡 DNS 不指向 ISP',
    physDns === undefined
      ? '未读到物理网卡 DNS'
      : `${v6.physicalAdapter}: ${physDns.v4.join(',') || '(空)'}${gateway === '' ? '' : `（期望 ${gateway}）`}`)

  // —— 裁决 ——
  const blocking = new Set(auditCfg.blockingSeverities)
  const blockingFailed = checks.filter(c => !c.ok && blocking.has(c.severity))
  const verdict = mode !== modes.global
    ? 'unprotected'
    : blockingFailed.length === 0
      ? 'safe'
      : 'leaking'

  return {
    verdict,
    checks,
    snapshot: {
      mode,
      modeName: name,
      globalNow,
      totalConnections: total,
      directConnections: directCount,
      egressIp: egressResult.ok === true ? egressResult.ip : null,
      realIp,
      systemProxy: sp,
      winhttp: wh,
      autoDoh: doh.autoDoh,
      ipv6: v6,
      dns: dnsList,
      tunGateway: gateway,
      config: cfg,
    },
  }
}

/* ------------------------------------------------------------------ *
 * 三段式切换
 * ------------------------------------------------------------------ */

/**
 * 三段式切换：一次调用完成「确认内核在跑 → 改内核 → 双写落盘 → 加固/撤销 → 回读校验」。
 *
 * 开头先确认内核活着：如果服务在但内核没起，自动拉起。不这么做的话
 * 「切到全局」会在一个没有内核的机器上返回一个漂亮的成功，而实际上什么都没保护。
 *
 * @param {object} options
 * @param {'global'|'rule'|'off'} options.mode
 * @param {object} options.target
 * @param {object} options.config
 * @param {object} options.paths
 * @param {object} [options.discovered] discover() 的返回值（用于内核控制）
 * @returns {Promise<object>}
 */

/**
 * 模式切换互斥队列。
 *
 * **为什么必须串行**：switchMode 要写基线、改两个配置文件、PATCH 内核、
 * 断连接、改 DNS/代理/IPv6 —— 一整串有顺序的系统操作。用户狂点三段开关
 * 会并发跑多份，两份交错写同一份基线文件就是竞态，能把系统搞进
 * 「一半 global 一半 rule」的中间态。
 *
 * 实现：promise 链。后来的调用排在前面那次的后面，绝不并发。
 */
let modeSwitchQueue = Promise.resolve()

/**
 * 把一次切换排进互斥队列。
 *
 * 注意实现细节：`run = queue.then(() => task())` 而不是 `queue.then(task)` ——
 * 后者会把 task 当 then 回调，它的返回值被 then 吞掉，调用方永远拿到 undefined。
 * 用箭头包一层，返回值才能穿透给调用方。
 *
 * @param {() => Promise<object>} task
 * @returns {Promise<object>}
 */
function enqueueModeSwitch(task) {
  const run = modeSwitchQueue.then(() => task(), () => task())
  // 队尾永远 resolve，避免某次失败卡死后面所有排队者
  modeSwitchQueue = run.then(() => undefined, () => undefined)
  return run
}

/** 对外入口：串行化的 switchMode。 */
export function switchMode(options) {
  return enqueueModeSwitch(() => switchModeInner(options))
}

/** switchMode 的实际实现（已保证同一时刻只有一个在跑）。 */
async function switchModeInner(options) {
  const { mode, config, paths, discovered } = options
  // target 可能被内核启动流程替换（内核重启后管道名会变），所以用 let
  let target = options.target
  const coreMode = coreModeOf(config.modes, mode)
  if (coreMode === '') {
    return { ok: false, requested: mode, effective: '', steps: [], error: `unknown mode: ${mode}` }
  }

  // 0. 内核必须活着 —— 全局模式下尤其如此
  let bootstrap = null
  if (mode !== 'off' && config.core.autoStartOnGlobal && discovered !== undefined && discovered !== null) {
    const startResult = await core.startKernel({
      config,
      discovered,
      target,
      refresh: options.refresh,
    })
    bootstrap = { ok: startResult.ok, method: startResult.method, detail: startResult.detail }
    // 内核刚起来时管道名是新的，用返回的 target 继续
    if (startResult.ok === true && startResult.target != null) {
      target = startResult.target
    }
  }

  const patch = await request(target, 'PATCH', '/configs', { mode: coreMode })
  if (!patch.ok) {
    return {
      ok: false,
      requested: mode,
      effective: '',
      steps: bootstrap === null ? [] : [{ step: 'start-kernel', ok: bootstrap.ok, detail: bootstrap.detail }],
      error: `${patch.status || patch.error}: ${String(patch.text).slice(0, 200)}`,
    }
  }

  // 落盘：**必须双写**（实测结论）。
  //
  //   · `clash-verge.yaml`（应用配置）—— GUI 打开时读它来重建 runtime；
  //   · `runtime/config.yaml`（服务运行配置）—— **服务重启内核时直接读这份**。
  //
  // 只写前者的话，内核一旦被服务重启（崩溃、手动重启、开机），mode 就回退成
  // runtime 里的旧值。这不是理论问题，是本机实测踩到的真 bug。
  const persistedWrites = []
  const writeTargets = []
  if (target.modeFile !== undefined && target.modeFile !== '') writeTargets.push(target.modeFile)
  if (config.verge.writeRuntimeConfig && Array.isArray(target.runtimeDirs)) {
    for (const dir of target.runtimeDirs) {
      const runtimeFile = `${dir}\\${config.discovery.runtimeConfigName}`
      if (!writeTargets.includes(runtimeFile)) writeTargets.push(runtimeFile)
    }
  }

  for (const file of writeTargets) {
    const result = verge.writeMode({
      file,
      mode: coreMode,
      modeKey: config.verge.modeKey,
      backupSuffix: config.verge.backupSuffix,
      tempSuffix: config.verge.tempSuffix,
    })
    persistedWrites.push({ file, ...result })
  }

  const persisted = persistedWrites.length > 0
    ? { ok: persistedWrites.every(w => w.ok === true), file: persistedWrites[0].file, previous: persistedWrites[0].previous ?? '', writes: persistedWrites }
    : { ok: false, file: '', previous: '', error: 'no config file discovered', writes: [] }

  const steps = mode === 'off'
    ? await unharden(config, paths, target)
    : await harden({ target, config, paths })

  const readback = await getJson(target, '/configs')
  return {
    ok: readback.mode === coreMode,
    requested: mode,
    effective: String(readback.mode ?? ''),
    persisted,
    bootstrap,
    steps,
    error: readback.mode === coreMode ? '' : `内核回读为 ${readback.mode}，与请求 ${coreMode} 不一致`,
  }
}

/* ------------------------------------------------------------------ *
 * 真 IP 校准
 * ------------------------------------------------------------------ */

/**
 * 校准真 IP。**必须**在保护关闭时做，否则采到的就是节点 IP。
 *
 * @param {object} options
 * @param {object} options.target
 * @param {object} options.config
 * @param {object} options.paths
 */
export async function calibrate(options) {
  const { target, config, paths } = options
  const cfg = await takeSnapshot({ target, config })
  const protecting = cfg.mode !== config.modes.off || cfg.tun.enable === true
  if (protecting) {
    return {
      ok: false,
      ip: '',
      reason: 'protection-active',
      detail: `当前 mode=${cfg.mode}, tun=${cfg.tun.enable}；校准必须在「关闭」状态做，否则采到的是节点 IP。`,
    }
  }
  const result = await probeDirect({ egress: config.egress })
  if (result.ok !== true) {
    return {
      ok: false,
      ip: '',
      reason: 'all-endpoints-failed',
      detail: result.attempts.map(a => `${a.url}: ${a.error ?? a.status}`).join(' / '),
    }
  }
  writeState(paths, { realIp: result.ip, realIpAt: Date.now(), realIpVia: result.via })

  return { ok: true, ip: result.ip, reason: '', detail: '' }
}
