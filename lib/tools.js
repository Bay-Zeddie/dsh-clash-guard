/**
 * 模型侧工具：五个，覆盖「看一眼 / 切一下 / 审一遍 / 换节点 / 校准真 IP」。
 *
 * 工具名、参数、输出 schema 全部走 defaults.tools 与 defaults 里的常量，
 * 渲染返回 ContentBlock[]（`finalizeContent` 在 tools/post-execute 之后才跑，
 * 只返回字符串会让下游消费者拿到裸字符串崩溃）。
 *
 * ## 关于 `@deepseek-ai/dsh-tools` 的解析
 *
 * **实测教训**：一开始为了「缺包时不炸宿主」把这里写成动态 import，结果工具
 * 全部静默消失 —— 因为纯 Node 的 `createRequire` 解析不到这个包（它由 DSH 的
 * ESM loader hook 在运行时提供，`dsh-free-search` 等第一方插件也解析不到）。
 *
 * 所以这里改回**静态 import**，与官方插件的用法一致：
 *   · DSH 里跑 → hook 提供这个包，工具正常注册；
 *   · 不在 DSH 里跑（普通 Node 单测）→ import 失败，那是**测试环境**的问题，
 *     不是插件的问题。真要在纯 Node 下跑测试，用 `tests/*.test.mjs` 里那种
 *     只测纯函数的做法，别测工具注册。
 *
 * 静态 import 失败会让整个模块加载失败 —— 但这只发生在「没有 DSH hook」的
 * 环境里，而那种环境下插件本来就不会被 DSH 加载，所以不会弄坏任何人的宿主。
 *
 * @module dsh-clash-guard/tools
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { getJson, request, getProxies, nodeHealth } from './mihomo.js'
import { probeIdentity, lookupIdentity } from './egress.js'
import { identityOf, ipApiIdentity, dnsEgressIps, buildReport } from './identity.js'
import { resolve } from './discover.js'
import { takeSnapshot } from './snapshot.js'
import * as guard from './guard.js'

/** 文本渲染助手。 */
function text(body) {
  return [{ type: 'text', text: body }]
}

/**
 * 严重度的中文标签。
 *
 * 内部 id（critical/high/medium/low）是 defaults 里的键，不改；
 * 只在**模型看到的那一面**翻成中文。
 */
const SEVERITY_LABEL = {
  critical: '严重',
  high: '高',
  medium: '中',
  low: '低',
}

/**
 * 解析 target：发现 + 探测 + 回填运行目录。
 * @param {object} config
 */
async function resolveTarget(config) {
  const found = await resolve(config === undefined ? {} : { settings: config, defaults: config })
  if (found.ok !== true) return { ok: false, found, target: null }
  return {
    ok: true,
    found,
    target: {
      ...found.target,
      runtimeDirs: found.discovered.runtimeDirs,
      requestTimeoutMs: config.controller.requestTimeoutMs,
    },
  }
}

/**
 * 注册全部工具。
 *
 * 同步注册：`defineTool` 是静态 import，模块加载成功就一定有它。
 * 返回释放函数；调用方负责在 fiber 销毁时调用。
 *
 * @param {object} scoped 注入了 tools 的 cordis 上下文
 * @param {object} deps { configOf, paths }
 * @returns {() => void} 释放函数
 */
export function registerTools(scoped, deps) {
  const { configOf, paths, guard } = deps
  const names = configOf().tools
  const disposers = []

  /* ---------------- clash_status ---------------- */
  disposers.push(scoped.tools.register(defineTool({
    name: names.status,
    description:
      'Read the Clash Verge / mihomo state: current mode (global/rule/direct), TUN and strict-route flags, '
      + 'the selector group\'s current outbound, live connection count, and how many of them bypass the proxy. '
      + 'Use it before and after switching modes to confirm what actually happened.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          reachable: { type: 'boolean' },
          version: { type: 'string' },
          mode: { type: 'string' },
          modeName: { type: 'string' },
          tun: { type: 'string' },
          strictRoute: { type: 'boolean' },
          selectorNow: { type: 'string' },
          connections: { type: 'number' },
          directConnections: { type: 'number' },
          transport: { type: 'string' },
          sources: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render(_args, value) {
        if (!value.reachable) return text(`Clash 控制器不可达：${value.error}`)
        return text([
          `Clash 状态（${value.transport}，来源 ${value.sources}）`,
          `版本：${value.version}`,
          `模式：${value.modeName}（core mode=${value.mode}）`,
          `TUN：${value.tun}，严格路由：${value.strictRoute ? '开' : '关'}`,
          `选择器出口：${value.selectorNow}`,
          `活连接：${value.connections} 条，其中直连 ${value.directConnections} 条`,
        ].join('\n'))
      },
    },
    async execute() {
      const config = configOf()
      try {
        const resolved = await resolveTarget(config)
        if (resolved.ok !== true) {
          return {
            reachable: false, version: '', mode: '', modeName: '', tun: '', strictRoute: false,
            selectorNow: '', connections: 0, directConnections: 0, transport: '',
            sources: '没有候选应答 /version', error: '控制器不可达',
          }
        }
        const target = resolved.target
        const snap = await takeSnapshot({ target, config })
        const group = await getJson(target, `/proxies/${encodeURIComponent(config.bypass.selectorGroup)}`).catch(() => null)
        const conns = await getJson(target, '/connections').catch(() => ({ connections: [] }))
        const list = Array.isArray(conns?.connections) ? conns.connections : []
        const direct = list.filter(c => Array.isArray(c.chains)
          && c.chains.length === 1
          && config.bypass.terminalNames.includes(c.chains[0])).length
        return {
          reachable: true,
          version: resolved.found.attempts.find(a => a.ok === true)?.version ?? '',
          mode: String(snap.mode ?? ''),
          modeName: guard.modeNameOf(config.modes, snap.mode),
          tun: snap.tun.enable === true ? `on (${snap.tun.stack ?? '?'})` : 'off',
          strictRoute: snap.tun.strictRoute === true,
          selectorNow: group === null ? '' : String(group.now ?? ''),
          connections: list.length,
          directConnections: direct,
          transport: target.transport,
          sources: target.source,
          error: '',
        }
      } catch (error) {
        return {
          reachable: false, version: '', mode: '', modeName: '', tun: '', strictRoute: false,
          selectorNow: '', connections: 0, directConnections: 0, transport: '', sources: '',
          error: String(error.message ?? error),
        }
      }
    },
  })))

  /* ---------------- clash_mode ---------------- */
  disposers.push(scoped.tools.register(defineTool({
    name: names.mode,
    description:
      'Switch Clash Verge between the three modes. `global` = every outbound packet goes through the proxy '
      + '(TUN + strict-route + system proxy + DNS hijack + IPv6 off are enforced as part of the switch, so no real '
      + 'IP can leak). `rule` = the profile\'s rules decide, so CN domains go DIRECT. `off` = direct, and every '
      + 'system change the guard made is rolled back. Use `global` for penetration-test work that must not expose '
      + 'the real IP.',
    parameters: {
      mode: {
        type: 'string',
        enum: ['global', 'rule', 'off'],
        description: 'global = everything through the proxy; rule = profile rules; off = direct + rollback.',
        required: true,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          requested: { type: 'string' },
          effective: { type: 'string' },
          persisted: { type: 'boolean' },
          persistedFile: { type: 'string' },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                step: { type: 'string' },
                ok: { type: 'boolean' },
                detail: { type: 'string' },
              },
            },
          },
          error: { type: 'string' },
        },
      },
      render(_args, value) {
        if (!value.ok) return text(`切换失败：${value.error || `实际生效 ${value.effective}`}`)
        const lines = [`已切到「${value.requested}」（内核 ${value.effective}）`]
        if (value.persistedFile !== '') {
          lines.push(`已写入 ${value.persistedFile}${value.persisted ? '' : '（失败）'}`)
        }
        for (const step of value.steps) {
          lines.push(`- ${step.ok ? '✔' : '✘'} ${step.step}: ${step.detail}`)
        }
        return text(lines.join('\n'))
      },
    },
    async execute(args) {
      const config = configOf()
      const resolved = await resolveTarget(config)
      if (resolved.ok !== true) {
        return {
          ok: false, requested: String(args.mode), effective: '', persisted: false,
          persistedFile: '', steps: [], error: '控制器不可达',
        }
      }
      const result = await guard.switchMode({
        mode: args.mode,
        target: resolved.target,
        config,
        paths,
        discovered: resolved.found.discovered,
      })
      return {
        ok: result.ok === true,
        requested: String(result.requested ?? args.mode),
        effective: String(result.effective ?? ''),
        persisted: result.persisted?.ok === true,
        persistedFile: String(result.persisted?.file ?? ''),
        steps: Array.isArray(result.steps)
          ? result.steps.map(s => ({ step: String(s.step), ok: s.ok === true, detail: String(s.detail ?? '') }))
          : [],
        error: String(result.error ?? ''),
      }
    },
  })))

  /* ---------------- clash_verify ---------------- */
  disposers.push(scoped.tools.register(defineTool({
    name: names.verify,
    description:
      'Run the full leak audit: mode, TUN, auto-route, strict-route, DNS fake-ip and hijack, the selector group\'s '
      + 'outbound, live connections that bypass the proxy, the egress IP versus the calibrated real IP, system proxy, '
      + 'WinHTTP, DoH auto-upgrade, physical-NIC IPv6, and the resolver in use. Verdict is `safe`, `leaking`, or '
      + '`unprotected`. Run it after switching to global, and again before starting a scan.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          verdict: { type: 'string' },
          egressIp: { type: 'string' },
          realIp: { type: 'string' },
          checks: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                severity: { type: 'string' },
                ok: { type: 'boolean' },
                title: { type: 'string' },
                detail: { type: 'string' },
              },
            },
          },
          error: { type: 'string' },
        },
      },
      render(_args, value) {
        if (value.error !== '') return text(`审计失败：${value.error}`)
        const mark = value.verdict === 'safe'
          ? '✔ 安全'
          : value.verdict === 'leaking' ? '✘ 正在泄漏' : '• 未受保护'
        const lines = [
          `泄漏审计：${mark}`,
          `出口 IP：${value.egressIp || '(取不到)'}　真 IP：${value.realIp || '(未校准)'}`,
        ]
        for (const check of value.checks) {
          const severity = SEVERITY_LABEL[check.severity] || check.severity
          lines.push(`${check.ok ? '✔' : '✘'} [${severity}] ${check.title} — ${check.detail}`)
        }
        return text(lines.join('\n'))
      },
    },
    async execute() {
      const config = configOf()
      try {
        const resolved = await resolveTarget(config)
        if (resolved.ok !== true) {
          return { verdict: 'unprotected', egressIp: '', realIp: '', checks: [], error: '控制器不可达' }
        }
        const result = await guard.audit({ target: resolved.target, config, paths })
        return {
          verdict: String(result.verdict),
          egressIp: result.snapshot.egressIp === null ? '' : String(result.snapshot.egressIp),
          realIp: result.snapshot.realIp === null ? '' : String(result.snapshot.realIp),
          checks: result.checks.map(c => ({
            id: c.id,
            severity: c.severity,
            ok: c.ok === true,
            title: c.title,
            detail: String(c.detail ?? ''),
          })),
          error: '',
        }
      } catch (error) {
        return { verdict: 'unprotected', egressIp: '', realIp: '', checks: [], error: String(error.message ?? error) }
      }
    },
  })))

  /* ---------------- clash_nodes ---------------- */
  disposers.push(scoped.tools.register(defineTool({
    name: names.nodes,
    description:
      'List the nodes inside the selector group with their last measured delay, and optionally pick one. In global '
      + 'mode that group decides where everything goes, so this is how you change exit region. Picking DIRECT or '
      + 'REJECT here would defeat the guard and is refused.',
    parameters: {
      pick: {
        type: 'string',
        description: 'Exact node name to select in the selector group. Omit to only list.',
      },
      limit: {
        type: 'integer',
        description: 'How many nodes to return (default from plugin settings, max from plugin settings).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          group: { type: 'string' },
          current: { type: 'string' },
          nodes: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string' },
                type: { type: 'string' },
                delay: { type: 'integer' },
                alive: { type: 'boolean' },
              },
            },
          },
          picked: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render(_args, value) {
        if (value.error !== '') return text(`节点操作失败：${value.error}`)
        const lines = [`${value.group} 当前：${value.current}${value.picked ? `　已切到：${value.picked}` : ''}`]
        for (const node of value.nodes) {
          lines.push(`- ${node.name} [${node.type}] ${node.alive ? `${node.delay}ms` : 'dead'}`)
        }
        return text(lines.join('\n'))
      },
    },
    async execute(args) {
      const config = configOf()
      const resolved = await resolveTarget(config)
      const groupName = config.bypass.selectorGroup
      if (resolved.ok !== true) {
        return { group: groupName, current: '', nodes: [], picked: '', error: '控制器不可达' }
      }
      const target = resolved.target
      try {
        const group = await getJson(target, `/proxies/${encodeURIComponent(groupName)}`)
        const all = Array.isArray(group.all) ? group.all : []
        const selectable = all.filter(name => !config.bypass.terminalNames.includes(name))
        const proxies = await getProxies(target)
        const rawLimit = Number(args.limit ?? config.ui.nodeListLimit)
        const limit = Math.min(
          Math.max(Number.isFinite(rawLimit) ? rawLimit : config.ui.nodeListLimit, 1),
          config.ui.nodeListMaxLimit,
        )
        const nodes = selectable.slice(0, limit).map((name) => {
          const health = nodeHealth(proxies[name])
          return {
            name: String(name),
            type: health.type,
            delay: health.delay,
            alive: health.alive,
          }
        })
        if (typeof args.pick === 'string' && args.pick !== '') {
          if (config.bypass.terminalNames.includes(args.pick)) {
            return { group: groupName, current: String(group.now ?? ''), nodes, picked: '', error: `${args.pick} 会让全局模式失效，已拒绝` }
          }
          if (!all.includes(args.pick)) {
            return { group: groupName, current: String(group.now ?? ''), nodes, picked: '', error: `${groupName} 组里没有「${args.pick}」` }
          }
          const res = await request(target, 'PUT', `/proxies/${encodeURIComponent(groupName)}`, { name: args.pick })
          if (!res.ok) {
            return { group: groupName, current: String(group.now ?? ''), nodes, picked: '', error: `${res.status || res.error}: ${String(res.text).slice(0, 160)}` }
          }
          const after = await getJson(target, `/proxies/${encodeURIComponent(groupName)}`)
          return { group: groupName, current: String(after?.now ?? ''), nodes, picked: args.pick, error: '' }
        }
        return { group: groupName, current: String(group.now ?? ''), nodes, picked: '', error: '' }
      } catch (error) {
        return { group: groupName, current: '', nodes: [], picked: '', error: String(error.message ?? error) }
      }
    },
  })))

  /* ---------------- clash_calibrate ---------------- */
  disposers.push(scoped.tools.register(defineTool({
    name: names.calibrate,
    description:
      'Record the machine\'s real public IP so later audits can prove the proxy is actually hiding it. This only '
      + 'works while protection is off (mode=direct and TUN off) — otherwise it would record the exit node\'s IP. '
      + 'Do it once, while disconnected from the proxy, then switch to global and run clash_verify.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          ip: { type: 'string' },
          reason: { type: 'string' },
          detail: { type: 'string' },
        },
      },
      render(_args, value) {
        if (!value.ok) return text(`校准失败：${value.detail || value.reason}`)
        return text(`已记录真 IP：${value.ip}（之后每次审计都会断言出口 IP 不等于它）`)
      },
    },
    async execute() {
      const config = configOf()
      const resolved = await resolveTarget(config)
      if (resolved.ok !== true) {
        return { ok: false, ip: '', reason: '控制器不可达', detail: '' }
      }
      const result = await guard.calibrate({ target: resolved.target, config, paths })
      return {
        ok: result.ok === true,
        ip: String(result.ip ?? ''),
        reason: String(result.reason ?? ''),
        detail: String(result.detail ?? ''),
      }
    },
  })))

  /* ---------------- clash_latency ---------------- */
  disposers.push(scoped.tools.register(defineTool({
    name: names.latency,
    description: '对 GLOBAL 组并发测速并按延迟排序。返回最快节点与完整排行，用于找可用节点。',
    parameters: {
      top: { type: 'number', description: '只返回前 N 个（默认 10，最大 30）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          elapsed: { type: 'number' },
          fastest: { type: 'string' },
          entries: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string' },
                delay: { type: 'number' },
              },
              required: ['name', 'delay'],
            },
          },
        },
      },
      render(_args, value) {
        if (!value.ok) return text(`延迟测试失败：${value.error}`)
        const lines = [`延迟测试（${value.elapsed}ms，${value.entries.length} 个节点）`]
        if (value.fastest) lines.push(`最快：${value.fastest}`)
        lines.push('')
        for (const entry of value.entries.slice(0, 12)) {
          const bar = '█'.repeat(Math.max(1, Math.round((300 - Math.min(entry.delay, 300)) / 20)))
          lines.push(`  ${String(entry.delay).padStart(5)}ms ${bar} ${entry.name}`)
        }
        if (value.entries.length > 12) lines.push(`  …（另有 ${value.entries.length - 12} 个）`)
        return text(lines.join('\n'))
      },
    },
    async execute(args) {
      const config = configOf()
      try {
        const resolved = await resolveTarget(config)
        if (resolved.ok !== true) {
          return { ok: false, elapsed: 0, fastest: '', entries: [], error: '控制器不可达' }
        }
        const started = Date.now()
        const testUrl = config.leaks.latencyTestUrl
        const raw = await request(resolved.target, 'GET',
          `/group/${encodeURIComponent(config.bypass.selectorGroup)}/delay?url=${encodeURIComponent(testUrl)}&timeout=2500`)
        const data = (() => { try { return JSON.parse(raw.text ?? '{}') } catch { return {} } })()
        const infoPatterns = Array.isArray(config.bypass.infoNodePatterns)
          ? config.bypass.infoNodePatterns.map(p => { try { return new RegExp(p, 'i') } catch { return null } }).filter(Boolean)
          : []
        const isInfo = name => infoPatterns.some(re => re.test(name))
        const entries = Object.entries(data)
          .filter(([name, delay]) => typeof delay === 'number' && delay > 0
            && !config.bypass.terminalNames.includes(name) && !isInfo(name))
          .map(([name, delay]) => ({ name, delay }))
          .sort((a, b) => a.delay - b.delay)
        return {
          ok: true,
          elapsed: Date.now() - started,
          fastest: entries[0] ? `${entries[0].delay}ms — ${entries[0].name}` : '',
          entries,
          error: '',
        }
      } catch (error) {
        return { ok: false, elapsed: 0, fastest: '', entries: [], error: String(error.message ?? error) }
      }
    },
  })))

  /* ---------------- clash_identity ---------------- */
  disposers.push(scoped.tools.register(defineTool({
    name: names.identity,
    description: 'Check whether the exit identity is really hidden: egress ASN/ISP/country vs the real IP, plus DNS leak detection. IP difference alone is not enough — the same ISP gives you another IP while keeping the same operator, and DNS may still resolve through the local carrier.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          verdict: { type: 'string' },
          egressIp: { type: 'string' },
          egressAsn: { type: 'string' },
          realIp: { type: 'string' },
          realAsn: { type: 'string' },
          identityLevel: { type: 'string' },
          identityDetail: { type: 'string' },
          dnsLevel: { type: 'string' },
          dnsDetail: { type: 'string' },
          dnsIps: { type: 'string' },
          fakeIpActive: { type: 'boolean' },
          reasons: { type: 'string' },
        },
      },
      render(_args, value) {
        if (!value.ok) return text(`身份探测失败：${value.reasons}`)
        const lines = [
          `出口身份：${value.egressIp || '—'}（${value.egressAsn || '未知 AS'}）`,
          `真 IP 身份：${value.realIp || '未校准'}（${value.realAsn || '未知 AS'}）`,
          `身份判定：${value.identityLevel} — ${value.identityDetail}`,
          `DNS 判定：${value.dnsLevel} — ${value.dnsDetail}`,
          `DNS 出口：${value.dnsIps || '—'}`,
          `fake-ip：${value.fakeIpActive ? '生效' : '未生效'}`,
          `综合结论：${value.verdict}`,
        ]
        return text(lines.join('\n'))
      },
    },
    async execute() {
      const config = configOf()
      try {
        const resolved = await resolveTarget(config)
        if (resolved.ok !== true) {
          return { ok: false, verdict: 'unknown', egressIp: '', egressAsn: '', realIp: '', realAsn: '',
            identityLevel: '', identityDetail: '', dnsLevel: '', dnsDetail: '', dnsIps: '',
            fakeIpActive: false, reasons: '控制器不可达' }
        }
        const target = resolved.target
        const cfg = await getJson(target, '/configs')
        const mixedPort = Number(cfg?.['mixed-port'] ?? 0)
        const probe = await probeIdentity({ mixedPort, egress: config.egress })
        const egressIdentity = probe.ok ? identityOf(probe.payload) : null
        const realIp = guard.readState(paths).realIp ?? ''
        let realIdentity = null
        if (realIp !== '') {
          if (realIp === (egressIdentity?.ip ?? '')) realIdentity = egressIdentity
          else {
            const lookup = await lookupIdentity({ ip: realIp, egress: config.egress })
            realIdentity = lookup.ok ? ipApiIdentity(lookup.payload) : null
            if (realIdentity !== null) realIdentity.ip = realIp
          }
        }
        const dnsQuery = await request(target, 'GET',
          `/dns/query?name=${encodeURIComponent(config.leaks.dnsEchoName)}&type=${encodeURIComponent(config.leaks.dnsEchoType)}`)
        const dnsIps = dnsQuery.ok ? dnsEgressIps(dnsQuery.text) : []
        const dnsIdentities = []
        for (const ip of dnsIps.slice(0, 3)) {
          const lookup = await lookupIdentity({ ip, egress: config.egress })
          if (lookup.ok) { const ident = ipApiIdentity(lookup.payload); if (ident !== null) { ident.ip = ip; dnsIdentities.push(ident) } }
        }
        const snap = await takeSnapshot({ target, config })
        const fakeIpActive = snap.dns.enhancedMode === 'fake-ip' && snap.dns.enable === true
        const report = buildReport({ egressIdentity, realIdentity, dnsIps, dnsIdentities, fakeIpActive })
        return {
          ok: true,
          verdict: report.verdict,
          egressIp: egressIdentity?.ip ?? '',
          egressAsn: egressIdentity ? `AS${egressIdentity.asn} ${egressIdentity.isp}` : '',
          realIp,
          realAsn: realIdentity ? `AS${realIdentity.asn} ${realIdentity.isp}` : '',
          identityLevel: report.identity.level,
          identityDetail: report.identity.detail,
          dnsLevel: report.dns.level,
          dnsDetail: report.dns.detail,
          dnsIps: dnsIps.join(', '),
          fakeIpActive,
          reasons: report.reasons.join('；'),
        }
      } catch (error) {
        return { ok: false, verdict: 'unknown', egressIp: '', egressAsn: '', realIp: '', realAsn: '',
          identityLevel: '', identityDetail: '', dnsLevel: '', dnsDetail: '', dnsIps: '',
          fakeIpActive: false, reasons: String(error.message ?? error) }
      }
    },
  })))

  return () => {
    for (const dispose of disposers) {
      try { dispose() } catch { /* 工具已随 fiber 销毁 */ }
    }
  }
}
