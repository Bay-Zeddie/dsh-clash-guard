/**
 * `/dsh-clash-guard/*` 同源路由 —— 面板唯一的读写通道。
 *
 * 只挂在 DSH 自己的 webServer 上（127.0.0.1 + 会话 cookie），不对外暴露。
 * 写操作要求 `content-type: application/json`：跨站表单发不出这个头，
 * 少一类 CSRF 面。
 *
 * 路径、上限、路由名全部来自 defaults.http，代码里没有字面量。
 *
 * @module dsh-clash-guard/http
 */
import { getJson, request, getProxies, nodeHealth } from './mihomo.js'
import { resolve, discover } from './discover.js'
import { takeSnapshot } from './snapshot.js'
import { packageRoot } from './paths.js'
import * as guard from './guard.js'
import * as win from './windows.js'
import * as core from './core.js'
import { inspectNetwork, healNetwork } from './selfheal.js'
import { probeViaProxy, probeSystemEgress, probeBoundEgress, probeIdentity, lookupIdentity } from './egress.js'
import { identityOf, ipApiIdentity, dnsEgressIps, buildReport } from './identity.js'
import { collectLeakFactors, verdictFromFactors } from './leak-factors.js'
import { probeInterfaceBypass, probeMachineTraffic, probeSystemResolver } from './leaks.js'
import fs from 'node:fs'
import path from 'node:path'

/** 统一 JSON 应答。 */
function json(res, status, body) {
  try {
    const payload = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(payload),
    })
    res.end(payload)
  } catch {
    // socket 可能已经没了
  }
}

/**
 * 读请求体（带上限与超时）。
 *
 * 上限防超大 payload；超时防「发一半就挂住」的连接 —— 没有它，
 * handler 会永远 await，socket 和内存都吊着。5 秒足够合法客户端用。
 *
 * @param {object} req
 * @param {number} limit 字节数
 * @returns {Promise<object|null>} null = 拒收（超限/坏 JSON/超时）
 */
function readJsonBody(req, limit) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      try { req.destroy() } catch { /* gone */ }
      finish(null)
    }, 5000)

    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        try { req.destroy() } catch { /* gone */ }
        finish(null)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        finish({})
        return
      }
      try {
        finish(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        finish(null)
      }
    })
    req.on('error', () => finish(null))
    req.on('close', () => finish(null))
  })
}

/** 是否 JSON 请求。 */
function isJsonRequest(req) {
  return String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')
}

/**
 * 只做发现，不探测。内核控制需要的是「期望状态在哪」，不依赖控制器是否活着。
 * @param {object} config
 */
async function discoverOnly(config) {
  return discover({ settings: config, defaults: config })
}

/**
 * 解析 target：发现 + 探测 + 回填运行目录。
 * 每次都重新走一遍，因为内核可能重启换了管道。
 * @param {object} config
 */
async function resolveTarget(config) {
  const found = await resolve({ settings: config, defaults: config })
  if (found.ok !== true) {
    return { ok: false, found, target: null }
  }
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
 * 注册全部路由。
 * @param {object} scoped 注入了 webServer 的 cordis 上下文
 * @param {object} deps { configOf, saveConfig, paths }
 * @returns {Array<() => void>} 释放函数
 */
export function registerRoutes(scoped, deps) {
  const { configOf, saveConfig, paths } = deps
  const disposers = []
  const routes = configOf().http.routes
  const prefix = configOf().http.prefix
  const maxBody = configOf().http.maxBodyBytes

  const targetOf = async () => resolveTarget(configOf())

  /* ---------------- GET /state ---------------- */
  disposers.push(scoped.webServer.register({
    kind: 'exact',
    path: `${prefix}${routes.state}`,
    handler: async (req, res) => {
      try {
        const config = configOf()
        const resolved = await targetOf()
        if (resolved.ok !== true) {
          json(res, 200, {
            ok: false,
            reachable: false,
            error: 'no controller candidate answered /version',
            attempts: resolved.found.attempts,
            installed: resolved.found.discovered.appDirs.length > 0,
          })
          return
        }
        const target = resolved.target
        const snap = await takeSnapshot({ target, config })
        const group = await getJson(target, `/proxies/${encodeURIComponent(config.bypass.selectorGroup)}`).catch(() => null)
        const state = guard.readState(paths)
        json(res, 200, {
          ok: true,
          reachable: true,
          version: resolved.found.attempts.find(a => a.ok === true)?.version ?? '',
          transport: target.transport,
          source: target.source,
          attempts: resolved.found.attempts,
          mode: String(snap.mode ?? ''),
          modeName: guard.modeNameOf(config.modes, snap.mode),
          storedMode: target.storedMode,
          modeFile: target.modeFile,
          tun: {
            enable: snap.tun.enable === true,
            stack: String(snap.tun.stack ?? ''),
            autoRoute: snap.tun.autoRoute === true,
            strictRoute: snap.tun.strictRoute === true,
          },
          dns: {
            enable: snap.dns.enable === true,
            enhancedMode: String(snap.dns.enhancedMode ?? ''),
            hijack: Array.isArray(snap.dns.hijack) ? snap.dns.hijack : [],
          },
          sources: snap.sources,
          yamlFile: snap.yamlFile,
          mixedPort: Number(snap.mixedPort ?? 0),
          selector: { group: config.bypass.selectorGroup, now: group === null ? '' : String(group.now ?? '') },
          realIp: typeof state.realIp === 'string' ? state.realIp : '',
          realIpAt: Number(state.realIpAt ?? 0),
          elevated: await win.isElevated(config.windows),
          settings: config,
        })
      } catch (error) {
        json(res, 200, { ok: false, reachable: false, error: String(error.message ?? error) })
      }
    },
  }))

  /* ---------------- POST /mode ---------------- */
  disposers.push(scoped.webServer.register({
    kind: 'exact',
    path: `${prefix}${routes.mode}`,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        json(res, 405, { ok: false, error: 'method-not-allowed' })
        return
      }
      if (!isJsonRequest(req)) {
        json(res, 415, { ok: false, error: 'unsupported-media-type' })
        return
      }
      const body = await readJsonBody(req, maxBody)
      if (body === null || typeof body.mode !== 'string') {
        json(res, 400, { ok: false, error: 'bad-body' })
        return
      }
      // **白名单校验**：只认 modes 里定义的三档。
      // 少了这一步，任意字符串都会被送进 switchMode —— 那是个未知档位，
      // 后果是配置写进一个内核不认的值，比直接拒绝危险得多。
      const allowed = Object.keys(configOf().modes)
      if (!allowed.includes(body.mode)) {
        json(res, 400, {
          ok: false,
          error: 'bad-mode',
          detail: `mode 必须是 ${allowed.join(' / ')} 之一，收到 ${JSON.stringify(body.mode)}`,
        })
        return
      }
      try {
        const config = configOf()
        const resolved = await targetOf()
        if (resolved.ok !== true) {
          json(res, 200, { ok: false, error: 'controller unreachable', attempts: resolved.found.attempts })
          return
        }
        const result = await guard.switchMode({
          mode: body.mode,
          target: resolved.target,
          config,
          paths,
          discovered: resolved.found.discovered,
        })
        json(res, 200, result)
      } catch (error) {
        json(res, 200, { ok: false, error: String(error.message ?? error) })
      }
    },
  }))

  /* ---------------- POST /verify ---------------- */
  disposers.push(scoped.webServer.register({
    kind: 'exact',
    path: `${prefix}${routes.verify}`,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        json(res, 405, { ok: false, error: 'method-not-allowed' })
        return
      }
      try {
        const config = configOf()
        const resolved = await targetOf()
        if (resolved.ok !== true) {
          json(res, 200, { ok: false, error: 'controller unreachable', attempts: resolved.found.attempts })
          return
        }
        // 先跑身份画像：DNS 泄漏是最隐蔽的暴露方式，审计必须覆盖
        let identityReport = null
        try {
          identityReport = await probeIdentityReport(resolved.target, config)
        } catch { /* 身份探测失败不该拖垮整个审计 */ }
        const result = await guard.audit({ target: resolved.target, config, paths, identityReport })
        json(res, 200, { ok: true, ...result })
      } catch (error) {
        json(res, 200, { ok: false, error: String(error.message ?? error) })
      }
    },
  }))

  /* ---------------- GET /nodes ---------------- */
  disposers.push(scoped.webServer.register({
    kind: 'exact',
    path: `${prefix}${routes.nodes}`,
    handler: async (req, res) => {
      try {
        const config = configOf()
        const resolved = await targetOf()
        if (resolved.ok !== true) {
          json(res, 200, { ok: false, error: 'controller unreachable', nodes: [] })
          return
        }
        const target = resolved.target
        const url = new URL(req.url ?? '/', 'http://localhost')
        const limitRaw = Number(url.searchParams.get('limit') ?? config.ui.nodeListLimit)
        const limit = Math.min(
          Math.max(Number.isFinite(limitRaw) ? limitRaw : config.ui.nodeListLimit, 1),
          config.ui.nodeListMaxLimit,
        )
        const groupName = url.searchParams.get('group') ?? config.bypass.selectorGroup
        const group = await getJson(target, `/proxies/${encodeURIComponent(groupName)}`)
        const all = Array.isArray(group.all) ? group.all : []
        // 过滤两类不该出现在列表里的节点：
        //   1. 直连/拒绝终结节点 —— 全局模式下切到它等于全量泄漏；
        //   2. 机场信息节点（「剩余流量」「套餐到期」这类假节点）——
        //      切到它等于断网。真机踩过：用户可切换列表里出现
        //      「剩余流量：8.37 GB」，点了之后 GLOBAL.now 指向一个
        //      没有出网能力的占位节点。
        const infoPatterns = Array.isArray(config.bypass.infoNodePatterns)
          ? config.bypass.infoNodePatterns.map(p => { try { return new RegExp(p, 'i') } catch { return null } }).filter(Boolean)
          : []
        const isInfoNode = name => infoPatterns.some(re => re.test(name))

        // proxies 必须先取：过滤策略组要看 type
        const proxies = await getProxies(target)

        /**
         * 策略组类型不是叶子节点。
         *
         * 真机踩到：GLOBAL 组里混着 17 个策略组（节点选择/ChatGPT/Netflix…），
         * 切到它们只是把选择权交给组内策略 —— 延迟永远显示「—」，
         * 用户点了一脸问号。列表里过滤，但 pick 仍允许（高级用法保留）。
         */
        const groupTypes = Array.isArray(config.bypass.groupTypes) ? config.bypass.groupTypes : []
        const isGroupNode = name => {
          if (groupTypes.length === 0) return false
          return groupTypes.includes(nodeHealth(proxies[name]).type)
        }
        const selectable = all.filter(name =>
          !config.bypass.terminalNames.includes(name) && !isInfoNode(name) && !isGroupNode(name))
        const nodes = selectable.slice(0, limit).map((name) => {
          const health = nodeHealth(proxies[name])
          return { name, type: health.type, delay: health.delay, alive: health.alive }
        })
        const pick = url.searchParams.get('pick')
        let picked = ''
        let error = ''

        // 切节点优先从 **POST body** 取（`{ node: '…' }`）。
        // query 里的 pick 保留兼容，但客户端已改用 POST —— 用 GET 改状态
        // 会被浏览器/代理缓存或预取，那会在用户没点的时候偷偷换节点。
        let wanted = pick
        if (req.method === 'POST') {
          const body = await readJsonBody(req, maxBody)
          if (body !== null && typeof body.node === 'string' && body.node !== '') {
            wanted = body.node
          }
        }

        if (wanted !== null && wanted !== '') {
          if (config.bypass.terminalNames.includes(wanted)) {
            error = `${wanted} 会让全局模式失效，已拒绝`
          } else if (isInfoNode(wanted)) {
            error = `「${wanted}」是机场信息节点，没有出网能力，已拒绝切换`
          } else if (!all.includes(wanted)) {
            error = `${groupName} 组里没有「${wanted}」`
          } else {
            const result = await request(target, 'PUT', `/proxies/${encodeURIComponent(groupName)}`, { name: wanted })
            if (result.ok) picked = wanted
            else error = `${result.status || result.error}: ${String(result.text).slice(0, 160)}`
          }
        }
        const after = await getJson(target, `/proxies/${encodeURIComponent(groupName)}`)
        json(res, 200, {
          ok: error === '',
          group: groupName,
          current: after === null ? '' : String(after.now ?? ''),
          nodes,
          picked,
          error,
        })
      } catch (error) {
        json(res, 200, { ok: false, error: String(error.message ?? error), nodes: [] })
      }
    },
  }))

  /* ---------------- POST /calibrate ---------------- */
  disposers.push(scoped.webServer.register({
    kind: 'exact',
    path: `${prefix}${routes.calibrate}`,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        json(res, 405, { ok: false, error: 'method-not-allowed' })
        return
      }
      try {
        const config = configOf()
        const resolved = await targetOf()
        if (resolved.ok !== true) {
          json(res, 200, { ok: false, reason: 'controller-unreachable', detail: '', ip: '' })
          return
        }
        const result = await guard.calibrate({ target: resolved.target, config, paths })
        json(res, 200, result)
      } catch (error) {
        json(res, 200, { ok: false, error: String(error.message ?? error) })
      }
    },
  }))

  /* ---------------- GET/POST /net —— 网络自愈 ---------------- */
  //
  // GET  = 体检（只读）：现在网络健康吗？有没有「DNS 指向死隧道」这类残留？
  // POST = 自愈：真的去修（重置 DNS、关死代理）。
  //
  // 这个端点是事故的正面回应：2026-11-18 两次「Clash 死了但 DNS 残留」
  // 的整机断网，用户只能手动敲 PowerShell。现在面板上一颗按钮的事。
  disposers.push(scoped.webServer.register({
    kind: 'exact',
    path: `${prefix}${routes.net}`,
    handler: async (req, res) => {
      try {
        const config = configOf()
        if (req.method === 'GET') {
          const report = await inspectNetwork({ config })
          json(res, 200, { ok: true, ...report })
          return
        }
        if (req.method === 'POST') {
          const result = await healNetwork({ config })
          json(res, 200, { ok: result.ok, ...result })
          return
        }
        json(res, 405, { ok: false, error: 'method-not-allowed' })
      } catch (error) {
        json(res, 200, { ok: false, error: String(error.message ?? error) })
      }
    },
  }))

  /* ---------------- GET /latency —— 全组延迟排行（借鉴 zashboard） ---------------- */
  //
  // 借鉴 mihomo 官方面板 metacubexd / zashboard 的核心交互：一键测全组延迟，
  // 按延迟排序找最快节点。底层是 mihomo 的 GET /group/{name}/delay，
  // 并发测全组，2.5s 超时。
  disposers.push(scoped.webServer.register({
    kind: 'exact',
    path: `${prefix}${routes.latency}`,
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        json(res, 405, { ok: false, error: 'method-not-allowed' })
        return
      }
      try {
        const config = configOf()
        const resolved = await targetOf()
        if (resolved.ok !== true) {
          json(res, 200, { ok: false, error: 'controller unreachable', entries: [] })
          return
        }
        const target = resolved.target
        const url = new URL(req.url ?? '/', 'http://localhost')
        const groupName = url.searchParams.get('group') ?? config.bypass.selectorGroup
        const testUrl = url.searchParams.get('url') ?? config.leaks.latencyTestUrl
        const timeout = Math.min(Number(url.searchParams.get('timeout') ?? 0) || 2500, 5000)

        const started = Date.now()
        const raw = await request(target, 'GET',
          `/group/${encodeURIComponent(groupName)}/delay?url=${encodeURIComponent(testUrl)}&timeout=${timeout}`)
        const data = (() => { try { return JSON.parse(raw.text ?? '{}') } catch { return {} } })()

        // 排除终结节点与信息节点，按延迟升序
        const infoPatterns = Array.isArray(config.bypass.infoNodePatterns)
          ? config.bypass.infoNodePatterns.map(p => { try { return new RegExp(p, 'i') } catch { return null } }).filter(Boolean)
          : []
        const isInfoNode = name => infoPatterns.some(re => re.test(name))
        const entries = Object.entries(data)
          .filter(([name, delay]) => typeof delay === 'number' && delay > 0
            && !config.bypass.terminalNames.includes(name) && !isInfoNode(name))
          .map(([name, delay]) => ({ name, delay }))
          .sort((a, b) => a.delay - b.delay)

        json(res, 200, {
          ok: true,
          group: groupName,
          elapsed: Date.now() - started,
          entries,
          fastest: entries[0] ?? null,
        })
      } catch (error) {
        json(res, 200, { ok: false, error: String(error.message ?? error), entries: [] })
      }
    },
  }))

  /**
   * 探测出口身份画像 + DNS 泄漏（/verify 与 /identity 共用）。
   *
   * 抽成函数而不是复制两遍：审计项与独立路由必须给出**同一份结论**，
   * 两处各写一遍迟早漂移。
   */
  async function probeIdentityReport(target, config) {
    const snap = await takeSnapshot({ target, config })
    const cfg = await getJson(target, '/configs')
    const mixedPort = Number(cfg?.['mixed-port'] ?? 0)

    const probe = await probeIdentity({ mixedPort, egress: config.egress })
    const egressIdentity = probe.ok ? identityOf(probe.payload) : null

    const realIp = guard.readState(paths).realIp ?? ''
    let realIdentity = null
    if (realIp !== '') {
      if (realIp === (egressIdentity?.ip ?? '')) {
        realIdentity = egressIdentity
      } else {
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
      if (lookup.ok) {
        const ident = ipApiIdentity(lookup.payload)
        if (ident !== null) { ident.ip = ip; dnsIdentities.push(ident) }
      }
    }

    const fakeIpActive = snap.dns.enhancedMode === 'fake-ip' && snap.dns.enable === true
    return buildReport({ egressIdentity, realIdentity, dnsIps, dnsIdentities, fakeIpActive })
  }

  /* ---------------- GET /identity —— 出口身份画像 + DNS 泄漏 ---------------- */
  //
  // 只看「出口 IP ≠ 真 IP」是不够的：
  //   · 同一家 ISP 的另一个 IP —— IP 变了，运营商还是你
  //   · 同一个国家另一个机房 —— IP 变了，地理还是你
  //   · DNS 走本地运营商 —— 出口是越南，DNS 出口还是中国移动
  // 业界标准（ipleak.net / dnsleaktest）分两路查：出口 AS/ISP/国家 + DNS 出口 IP。
  disposers.push(scoped.webServer.register({
    kind: 'exact',
    path: `${prefix}${routes.identity}`,
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        json(res, 405, { ok: false, error: 'method-not-allowed' })
        return
      }
      try {
        const config = configOf()
        const resolved = await targetOf()
        if (resolved.ok !== true) {
          json(res, 200, { ok: false, error: 'controller unreachable', report: null })
          return
        }
        const target = resolved.target
        const report = await probeIdentityReport(target, config)
        json(res, 200, { ok: true, report, egressIp: report?.identity?.egressIp ?? '', dnsIps: report?.dns?.ips ?? [] })
      } catch (error) {
        json(res, 200, { ok: false, error: String(error.message ?? error), report: null })
      }
    },
  }))

  /* ---------------- GET /rules-stats —— 规则命中统计 ---------------- */
  //
  // /rules 的 extra.hitCount 记录了每条规则的真实命中次数。
  // 3877 条规则里只有 ~19 条在真正工作 —— 死规则占比是配置质量的直接指标。
  disposers.push(scoped.webServer.register({
    kind: 'exact',
    path: `${prefix}${routes["rules-stats"]}`,
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        json(res, 405, { ok: false, error: 'method-not-allowed' })
        return
      }
      try {
        const resolved = await targetOf()
        if (resolved.ok !== true) {
          json(res, 200, { ok: false, error: 'controller unreachable' })
          return
        }
        const rules = await getJson(resolved.target, '/rules')
        const all = Array.isArray(rules?.rules) ? rules.rules : []
        const byType = {}
        let totalHit = 0
        const topHits = []
        for (const rule of all) {
          byType[rule.type] = (byType[rule.type] ?? 0) + 1
          const hits = rule.extra?.hitCount ?? 0
          totalHit += hits
          if (hits > 0) topHits.push({ type: rule.type, payload: rule.payload, proxy: rule.proxy, hits })
        }
        topHits.sort((a, b) => b.hits - a.hits)
        json(res, 200, {
          ok: true,
          total: all.length,
          byType,
          totalHit,
          activeCount: topHits.length,
          deadCount: all.length - topHits.length,
          deadPercent: all.length > 0 ? Math.round(((all.length - topHits.length) / all.length) * 100) : 0,
          topHits: topHits.slice(0, 20),
        })
      } catch (error) {
        json(res, 200, { ok: false, error: String(error.message ?? error) })
      }
    },
  }))

  /* ---------------- GET/POST /settings ---------------- */
  disposers.push(scoped.webServer.register({
    kind: 'exact',
    path: `${prefix}${routes.settings}`,
    handler: async (req, res) => {
      if (req.method === 'GET') {
        json(res, 200, { ok: true, settings: configOf() })
        return
      }
      if (req.method !== 'POST') {
        json(res, 405, { ok: false, error: 'method-not-allowed' })
        return
      }
      if (!isJsonRequest(req)) {
        json(res, 415, { ok: false, error: 'unsupported-media-type' })
        return
      }
      const body = await readJsonBody(req, maxBody)
      if (body === null) {
        json(res, 400, { ok: false, error: 'bad-body' })
        return
      }
      try {
        const next = saveConfig(body)
        json(res, 200, { ok: true, settings: next })
      } catch (error) {
        json(res, 200, { ok: false, error: String(error.message ?? error) })
      }
    },
  }))

  /* ---------------- GET /i18n ---------------- */
  disposers.push(scoped.webServer.register({
    kind: 'exact',
    path: `${prefix}${routes.i18n}`,
    handler: async (_req, res) => {
      try {
        const config = configOf()
        const file = path.join(packageRoot(), config.locale.file)
        const table = JSON.parse(fs.readFileSync(file, 'utf8'))
        json(res, 200, { ok: true, fallback: config.locale.fallback, table })
      } catch (error) {
        json(res, 200, { ok: false, error: String(error.message ?? error), table: {} })
      }
    },
  }))

  /* ---------------- GET/POST /kernel ---------------- */
  disposers.push(scoped.webServer.register({
    kind: 'exact',
    path: `${prefix}${routes.kernel}`,
    handler: async (req, res) => {
      try {
        const config = configOf()
        const discovered = await discoverOnly(config)

        // GET：只读内核状态
        if (req.method === 'GET') {
          const found = await resolve({ settings: config, defaults: config })
          const target = found.ok ? {
            ...found.target,
            runtimeDirs: found.discovered.runtimeDirs,
          } : null
          const state = await core.kernelState({
            config,
            discovered: found.discovered,
            target,
          })
          json(res, 200, { ok: true, state })
          return
        }

        if (req.method !== 'POST') {
          json(res, 405, { ok: false, error: 'method-not-allowed' })
          return
        }
        if (!isJsonRequest(req)) {
          json(res, 415, { ok: false, error: 'unsupported-media-type' })
          return
        }

        const body = await readJsonBody(req, maxBody)
        if (body === null || typeof body.action !== 'string') {
          json(res, 400, { ok: false, error: 'bad-body' })
          return
        }

        const found = await resolve({ settings: config, defaults: config })
        const target = found.ok ? {
          ...found.target,
          runtimeDirs: found.discovered.runtimeDirs,
        } : null

        let result
        if (body.action === 'start') {
          result = await core.startKernel({
            config,
            discovered: found.discovered,
            target,
            refresh: core.makeRefresher(config, resolve),
          })
        } else if (body.action === 'restart') {
          result = await core.restartKernel({
            config,
            discovered: found.discovered,
            target,
            refresh: core.makeRefresher(config, resolve),
          })
        } else {
          json(res, 400, { ok: false, error: `unknown action: ${body.action}` })
          return
        }

        // 动作完再读一次状态，让面板拿到事实而不是意图
        const after = await resolve({ settings: config, defaults: config })
        const state = await core.kernelState({
          config,
          discovered: after.discovered,
          target: after.ok ? { ...after.target, runtimeDirs: after.discovered.runtimeDirs } : null,
        })
        json(res, 200, { ok: result.ok === true, action: body.action, method: result.method, detail: result.detail, state })
      } catch (error) {
        json(res, 200, { ok: false, error: String(error.message ?? error) })
      }
    },
  }))

  /* ---------------- GET /ip ---------------- */
  //
  // 指示灯专用：回答「这台电脑在用什么 IP 出去」。
  //
  // **不是只测代理端口**。三条路径分别回答三个问题：
  //
  //   1. 系统出口（走默认路由）→ 用户平时上网时外面看到谁
  //   2. 代理出口（走混合端口）→ 走代理的程序外面看到谁
  //   3. 绑卡出口（绑物理网卡）→ **最尖锐**：绑了网卡的程序会不会暴露真 IP
  //
  // 第 3 条是关键：Windows 上绑源地址会强制走该网卡、无视路由表，
  // 所以它是「真 IP 有没有可能漏」的实证。任一非空且等于校准真 IP 就是泄漏。
  disposers.push(scoped.webServer.register({
    kind: 'exact',
    path: `${prefix}${routes.ip}`,
    handler: async (_req, res) => {
      try {
        const config = configOf()
        const state = guard.readState(paths)
        const realIp = typeof state.realIp === 'string' && state.realIp !== '' ? state.realIp : ''
        const found = await resolve({ settings: config, defaults: config })

        // 控制器不可达时仍要能测「系统出口」与「绑卡出口」——
        // 那两个不依赖 mihomo，代理挂了正是最该看它们的时候。
        const v6 = await win.readIpv6State(config.windows, config.discovery).catch(() => ({ physicalAdapter: '', globalAddresses: [], ipv6Bound: false }))
        const adapter = await win.readAdapterAddresses(config.windows, config.discovery, v6.physicalAdapter)
          .catch(() => ({ addresses: [], primary: '' }))

        // 三条路径**同时开跑**。
        //
        // 之前系统/绑卡先跑、代理后跑，绑卡超时 12s×3 串行 = 36s，
        // 指示灯点一下要等半分钟。现在并发 + 绑卡短超时，总耗时 ≈ 最慢的那条。
        const proxyTask = (async () => {
          if (found.ok !== true) {
            return { egress: { ok: false, ip: '', via: '', detail: '控制器不可达' }, snap: null }
          }
          const target = { ...found.target, runtimeDirs: found.discovered.runtimeDirs }
          const snap = await takeSnapshot({ target, config })
          const one = await probeViaProxy({
            mixedPort: Number(snap.mixedPort ?? target.mixedPort ?? 0),
            egress: config.egress,
            proxyHost: config.egress.proxyHost,
          })
          return {
            snap,
            egress: {
              ok: one.ok === true,
              ip: one.ok === true ? one.ip : '',
              via: one.ok === true ? one.via : '',
              detail: one.ok === true ? '' : one.attempts.map(a => a.error ?? String(a.status)).join(' / ').slice(0, 160),
            },
          }
        })()

        const [systemEgress, boundEgress, proxyResult] = await Promise.all([
          probeSystemEgress({ egress: config.egress }),
          probeBoundEgress({ localAddress: adapter.primary, egress: config.egress }),
          proxyTask,
        ])

        const proxyEgress = proxyResult.egress
        const snap = proxyResult.snap
        const modeName = snap === null ? '' : guard.modeNameOf(config.modes, snap.mode)

        // —— 全因素泄漏聚合判定 ——
        //
        // 只看「出口 IP ≠ 真 IP」会给假绿。真机实测过：出口在越南、
        // 运营商换了、国家也换了，但 **DNS 出口还在 China Mobile** ——
        // 本地运营商能看到你解析的每一个域名。那种状态原来显示绿色「已隐藏」。
        //
        // 现在把会暴露身份的因素全部收进来（lib/leak-factors.js），
        // 任一 critical 命中即报红。绿（安全）必须满足「一个因素都没有」。

        // 1. 出口 IP 等于真 IP 的路径
        const exposedPaths = []
        if (realIp !== '') {
          if (systemEgress.ok && systemEgress.ip === realIp) exposedPaths.push('system')
          if (boundEgress.ok && boundEgress.ip === realIp) exposedPaths.push('bound')
          if (proxyEgress.ok && proxyEgress.ip === realIp) exposedPaths.push('proxy')
        }

        // 2. 其余探针并发跑。任一条失败都不该拖垮整个判定 —— 用 catch 兜住。
        const safe = (promise, fallback) => Promise.resolve(promise).catch(() => fallback)
        const [dnsReport, bypassProbe, trafficProbe, resolverProbe] = await Promise.all([
          safe(found.ok === true ? probeIdentityReport(found.target, config) : null, null),
          safe(probeInterfaceBypass({ localAddress: adapter.primary, config }), null),
          safe(probeMachineTraffic({ config, physicalIp: adapter.primary }), null),
          safe(probeSystemResolver({ config }), null),
        ])

        const tunEnabled = snap === null ? null : (snap.tun.enable === true)
        const strictRoute = snap === null ? null : (snap.tun.strictRoute === true)
        const fakeIpActive = snap === null
          ? null
          : (snap.dns.enable === true && snap.dns.enhancedMode === 'fake-ip')

        const factors = collectLeakFactors({
          exposedPaths,
          dnsLeak: dnsReport === null ? null : dnsReport.dns,
          interfaceBypass: bypassProbe,
          machineTraffic: trafficProbe,
          tunEnabled,
          strictRoute,
          fakeIpActive,
          systemResolver: resolverProbe,
        })

        const decision = verdictFromFactors(factors, {
          calibrated: realIp !== '',
          egressOk: proxyEgress.ok || systemEgress.ok || boundEgress.ok,
        })
        const verdict = decision.verdict
        const tone = decision.tone

        json(res, 200, {
          ok: verdict !== 'no-egress',
          phase: found.ok === true ? 'ok' : 'unreachable',
          verdict,
          tone,
          // 命中的泄漏因素 —— 悬停提示逐条列出，用户知道到底哪里漏了
          factors,
          reason: decision.reason,
          realIp,
          exposedPaths,
          // 三条路径各自的结论
          system: { ip: systemEgress.ip, ok: systemEgress.ok },
          proxy: { ip: proxyEgress.ip, ok: proxyEgress.ok, detail: proxyEgress.detail },
          bound: { ip: boundEgress.ip, ok: boundEgress.ok, detail: boundEgress.detail },
          adapter: adapter.primary,
          // 供面板显示
          egressIp: proxyEgress.ip || systemEgress.ip || boundEgress.ip || '',
          mode: snap === null ? '' : String(snap.mode ?? ''),
          modeName,
          via: proxyEgress.via,
          checkedAt: Date.now(),
        })
      } catch (error) {
        json(res, 200, { ok: false, phase: 'error', tone: 'off', egressIp: '', realIp: '', error: String(error.message ?? error) })
      }
    },
  }))

  return disposers
}

export { json, readJsonBody, resolveTarget }
