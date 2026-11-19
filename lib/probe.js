/**
 * 泄漏探测 —— 单次完整探测的实现。
 *
 * 抽成独立模块的原因：**路由与宿主监控器必须给出同一份结论**。
 * 两处各写一遍探针流程，迟早漂移 —— 上一轮就出现过面板说 safe、
 * 指示灯说 leaking 的问题。
 *
 * 本模块只做探测与判定，**不缓存、不调度**（那是 monitor.js 的事）。
 */

import { resolve } from './discover.js'
import { takeSnapshot } from './snapshot.js'
import { probeViaProxy, probeSystemEgress, probeBoundEgress, probeIdentity, lookupIdentity } from './egress.js'
import { probeInterfaceBypass, probeMachineTraffic, probeSystemResolver } from './leaks.js'
import { readIpv6State, readAdapterAddresses, readAdapterInfo } from './windows.js'
import { identityOf, ipApiIdentity, dnsEgressIps, buildReport } from './identity.js'
import { collectLeakFactors, verdictFromFactors } from './leak-factors.js'
import { getJson, request } from './mihomo.js'

/**
 * 探测器工厂。
 *
 * @param {object} options
 * @param {() => object} options.configOf 取配置
 * @param {object} options.paths 状态文件路径
 * @param {object} options.guard guard 模块（readState / modeNameOf）
 */
export function createProbe(options) {
  const { configOf, paths, guard } = options

  /** 身份画像缓存（ipleak.net / ip-api.com 查询贵，30 秒复用）。 */
  const identityCache = { at: 0, report: null, key: '' }
  const IDENTITY_CACHE_MS = 30000

  /** 绑卡探针缓存（结果只随 TUN 状态与网卡地址变化）。 */
  const boundCache = { at: 0, value: null, key: '' }
  const BOUND_CACHE_MS = 30000

  /** 网卡信息缓存（60 秒）。 */
  const adapterCache = { at: 0, value: null }
  const ADAPTER_CACHE_MS = 60000

  /**
   * **慢档已发现的隐蔽因素**（DNS 泄漏、绑卡绕过、直连进程、系统解析）。
   *
   * 为什么必须持久化：快档只测 IP 相关的部分，如果它独立出 verdict，
   * 就会出现「假绿」—— DNS 明明在泄漏，但快档说 safe，用户看到绿色。
   *
   * 真实场景：DNS 泄漏存在 + TUN 开着 + IP 没暴露
   *   · 快档独立判定 → safe（绿）← 假绿
   *   · 慢档判定     → leaking（红）← 真相
   *
   * 所以：**任何慢档发现的 critical/high 因素都会一直保留**，
   * 快档只能新增自己的因素，不能抹掉慢档的。
   */
  const deepFactors = { value: [], at: 0 }

  async function probeIdentityReport(target, config, probeOptions) {
    const force = probeOptions !== undefined && probeOptions.force === true
    let modeNow = ''
    let selectorNow = ''
    if (target !== null && target !== undefined) {
      try {
        const live = await getJson(target, '/configs')
        modeNow = String(live?.mode ?? '')
        const group = await getJson(target, `/proxies/${encodeURIComponent(config.bypass.selectorGroup)}`)
        selectorNow = String(group?.now ?? '')
      } catch { /* 控制器抖动时退回无键缓存，靠 TTL 兜底 */ }
    }
    const cacheKey = target === null || target === undefined
      ? ''
      : `${target.pipeName ?? ''}|${target.tcpPort ?? ''}|${modeNow}|${selectorNow}`
    if (force !== true
      && identityCache.report !== null
      && identityCache.key === cacheKey
      && Date.now() - identityCache.at < IDENTITY_CACHE_MS) {
      return identityCache.report
    }

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
    const report = buildReport({ egressIdentity, realIdentity, dnsIps, dnsIdentities, fakeIpActive })
    identityCache.at = Date.now()
    identityCache.report = report
    identityCache.key = cacheKey
    return report
  }

  /**
   * **快档探测** —— 只测最核心的「IP 有没有暴露」。
   *
   * 为什么分两档：全量探测要 5-7 秒（DNS 身份反查、绑卡、直连进程…），
   * 而用户要的是「第一时间知道 IP 状态」。IP 是否等于真 IP 只需要：
   *   · 三条出口 IP（系统 / 代理 / 绑卡）
   *   · TUN / strict-route / fake-ip 状态
   * 目标 2 秒内出结果。
   *
   * 快档结论 = 「IP 层面是否暴露」。慢档补上隐蔽泄漏因素。
   */
  async function probeFast(probeOptions) {
    const config = configOf()
    const state = guard.readState(paths)
    const realIp = typeof state.realIp === 'string' && state.realIp !== '' ? state.realIp : ''
    const found = await resolve({ settings: config, defaults: config })

    /**
     * 网卡信息：**一次 PowerShell 读全部**（readAdapterInfo），带 60 秒缓存。
     *
     * 原来是 readIpv6State + readAdapterAddresses 两次调用 —— 各 1 次
     * shell，合计 4.2 秒，而快档预算只有 3 秒。合并后缓存命中是 0ms。
     */
    const net = await readAdapterInfo(config.windows, config.discovery)
      .catch(() => ({ physicalAdapter: '', globalAddresses: [], ipv6Bound: false, addresses: [], primary: '' }))
    const v6 = net
    const adapter = net

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

    /**
     * 快档的绑卡出口**不现场探测**。
     *
     * probeBoundEgress 实测 4.3 秒（绑定物理网卡 + 3 个端点 × 3 秒超时），
     * 而它的结果在 TUN 配置不变时是**恒定的** —— 绑卡能不能直连不随时间变化。
     * 所以：第一次由慢档探出来，之后直接复用。
     *
     * 快档只测两条真正会变的路径：系统出口与代理出口（各 <1 秒）。
     */
    const boundResult = boundCache.value !== null
      ? boundCache.value
      : { ip: '', ok: false, detail: '绑卡出口待慢档首次探测' }
    const [systemEgress, proxyResult] = await Promise.all([
      probeSystemEgress({ egress: config.egress }),
      proxyTask,
    ])
    const boundEgress = boundResult

    const proxyEgress = proxyResult.egress
    const snap = proxyResult.snap

    const exposedPaths = []
    if (realIp !== '') {
      if (systemEgress.ok && systemEgress.ip === realIp) exposedPaths.push('system')
      if (boundEgress.ok && boundEgress.ip === realIp) exposedPaths.push('bound')
      if (proxyEgress.ok && proxyEgress.ip === realIp) exposedPaths.push('proxy')
    }

    const fastFactors = collectLeakFactors({
      exposedPaths,
      dnsLeak: null,
      interfaceBypass: null,
      machineTraffic: null,
      tunEnabled: snap === null ? null : (snap.tun.enable === true),
      strictRoute: snap === null ? null : (snap.tun.strictRoute === true),
      fakeIpActive: snap === null
        ? null
        : (snap.dns.enable === true && snap.dns.enhancedMode === 'fake-ip'),
      systemResolver: null,
    })

    /**
     * **合并慢档发现的隐蔽因素** —— 杜绝「假绿」。
     *
     * 快档只测 IP 相关的部分。如果它独立出 verdict，那么
     * 「DNS 在泄漏 + TUN 开着 + IP 没暴露」会判成 safe（绿），
     * 而慢档的真实结论是 leaking（红）。
     *
     * 现在：慢档发现的 critical/high 因素**一直保留**，快档只能新增，
     * 不能抹掉。绿灯只在「所有档位都没发现任何问题」时才出现。
     */
    // 按 id 去重（快慢档可能命中同一个因素）—— 保留级别更高的那个
    const merged = new Map()
    for (const f of fastFactors.concat(deepFactors.value)) {
      const prev = merged.get(f.id)
      if (prev === undefined) { merged.set(f.id, f); continue }
      const rank = { critical: 0, high: 1, warn: 2 }
      if ((rank[f.level] ?? 9) < (rank[prev.level] ?? 9)) merged.set(f.id, f)
    }
    // 按严重度排序：critical → high → warn
    const rank = { critical: 0, high: 1, warn: 2 }
    const factors = [...merged.values()].sort((a, b) => (rank[a.level] ?? 9) - (rank[b.level] ?? 9))
    const decision = verdictFromFactors(factors, {
      calibrated: realIp !== '',
      egressOk: proxyEgress.ok || systemEgress.ok || boundEgress.ok,
    })

    return {
      ok: decision.verdict !== 'no-egress',
      phase: found.ok === true ? 'ok' : 'unreachable',
      verdict: decision.verdict,
      tone: decision.tone,
      factors,
      reason: decision.reason,
      fixes: decision.fixes ?? [],
      realIp,
      exposedPaths,
      system: { ip: systemEgress.ip, ok: systemEgress.ok },
      proxy: { ip: proxyEgress.ip, ok: proxyEgress.ok, detail: proxyEgress.detail },
      bound: { ip: boundEgress.ip, ok: boundEgress.ok, detail: boundEgress.detail },
      adapter: adapter.primary,
      egressIp: proxyEgress.ip || systemEgress.ip || boundEgress.ip || '',
      mode: snap === null ? '' : String(snap.mode ?? ''),
      modeName: snap === null ? '' : guard.modeNameOf(config.modes, snap.mode),
      via: proxyEgress.via,
      tier: 'fast',
    }
  }

  /**
   * 一次完整探测。
   *
   * @param {object} [probeOptions]
   * @param {boolean} [probeOptions.force] 绕过所有缓存
   */
  async function probe(probeOptions) {
    const config = configOf()
    const state = guard.readState(paths)
    const realIp = typeof state.realIp === 'string' && state.realIp !== '' ? state.realIp : ''
    const found = await resolve({ settings: config, defaults: config })
    const force = probeOptions !== undefined && probeOptions.force === true

    // 控制器不可达时仍要能测「系统出口」与「绑卡出口」——
    // 那两个不依赖 mihomo，代理挂了正是最该看它们的时候。
    const net = await readAdapterInfo(config.windows, config.discovery)
      .catch(() => ({ physicalAdapter: '', globalAddresses: [], ipv6Bound: false, addresses: [], primary: '' }))
    const v6 = net
    const adapter = net

    const safe = (promise, fallback) => Promise.resolve(promise).catch(() => fallback)

    // 三条路径同时开跑：系统出口 / 绑卡出口 / 代理出口
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

    // 绑卡出口的结果写进缓存供**快档**复用 —— 它在 TUN 配置不变时恒定，
    // 不需要快档每次重测（那要 4.3 秒）。
    boundCache.at = Date.now()
    boundCache.key = `${snap === null ? '?' : (snap.tun.enable === true ? 'tun' : 'notun')}|${adapter.primary}`
    boundCache.value = { ip: boundEgress.ip, ok: boundEgress.ok, detail: boundEgress.detail }

    // 1. 出口 IP 等于真 IP 的路径
    const exposedPaths = []
    if (realIp !== '') {
      if (systemEgress.ok && systemEgress.ip === realIp) exposedPaths.push('system')
      if (boundEgress.ok && boundEgress.ip === realIp) exposedPaths.push('bound')
      if (proxyEgress.ok && proxyEgress.ip === realIp) exposedPaths.push('proxy')
    }

    // 2. 绑卡绕过探针（单独缓存：结果只随 TUN 状态与网卡地址变化）
    const boundKey = `${snap === null ? '?' : (snap.tun.enable === true ? 'tun' : 'notun')}|${adapter.primary}`
    const boundCacheHit = force !== true
      && boundCache.value !== null
      && boundCache.key === boundKey
      && Date.now() - boundCache.at < BOUND_CACHE_MS
    const boundResults = boundCacheHit
      ? boundCache.value
      : await Promise.all([
        safe(probeInterfaceBypass({ localAddress: adapter.primary, config }), null),
      ]).then(([bypass]) => {
        const value = { bypass }
        boundCache.at = Date.now()
        boundCache.key = boundKey
        boundCache.value = value
        return value
      })

    // 3. 其余探针并发跑，任一失败不拖垮判定
    const [dnsReport, trafficProbe, resolverProbe] = await Promise.all([
      safe(found.ok === true
        ? probeIdentityReport(found.target, config, { force })
        : null, null),
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
      interfaceBypass: boundResults.bypass,
      machineTraffic: trafficProbe,
      tunEnabled,
      strictRoute,
      fakeIpActive,
      systemResolver: resolverProbe,
    })

    // **记住慢档发现的隐蔽因素** —— 快档会用它们，避免「假绿」。
    // 只保留 critical/high：warn 级（如 fake-ip 未生效）会随状态变化，
    // 由快档自己实时判断更准。
    const deep = factors.filter(f => f.level === 'critical' || f.level === 'high')
    if (deep.length > 0) {
      deepFactors.value = deep
      deepFactors.at = Date.now()
    }

    const decision = verdictFromFactors(factors, {
      calibrated: realIp !== '',
      egressOk: proxyEgress.ok || systemEgress.ok || boundEgress.ok,
    })

    return {
      ok: decision.verdict !== 'no-egress',
      phase: found.ok === true ? 'ok' : 'unreachable',
      verdict: decision.verdict,
      tone: decision.tone,
      factors,
      reason: decision.reason,
      fixes: decision.fixes ?? [],
      realIp,
      exposedPaths,
      system: { ip: systemEgress.ip, ok: systemEgress.ok },
      proxy: { ip: proxyEgress.ip, ok: proxyEgress.ok, detail: proxyEgress.detail },
      bound: { ip: boundEgress.ip, ok: boundEgress.ok, detail: boundEgress.detail },
      adapter: adapter.primary,
      egressIp: proxyEgress.ip || systemEgress.ip || boundEgress.ip || '',
      mode: snap === null ? '' : String(snap.mode ?? ''),
      modeName,
      via: proxyEgress.via,
    }
  }

  return { probe, probeFast, probeIdentityReport, _caches: { identityCache, boundCache, adapterCache } }
}
