/**
 * 泄漏因素聚合判定。
 *
 * 指示灯原来的判定只看一件事：出口 IP 是否等于真 IP。这远远不够 ——
 * 真机实测证明：出口 IP 在越南、运营商也换了、国家也换了，看起来完美，
 * **但 DNS 出口还在 China Mobile**，本地运营商能看到你解析的每一个域名。
 * 那种状态下指示灯是绿的「已隐藏」，而实际上是泄漏的。
 *
 * 这里把「会暴露真实身份的因素」全部收进来，任一命中就报红。
 * 纯函数，零 IO —— 探针在 http.js 里跑，结论在这里算。
 */

/**
 * 泄漏因素清单。
 *
 * level 决定指示灯颜色：
 *   critical → 红（真 IP 或真实地区正在暴露）
 *   high     → 红（随时会暴露，只是当前没抓到）
 *   warn     → 黄（防护不完整，但没在暴露）
 */
export const LEAK_FACTORS = [
  {
    id: 'egress-equals-real',
    level: 'critical',
    title: '出口 IP 就是真 IP',
    fix: '切到「全局」档，让所有流量走代理',
    detail: paths => `系统/代理/绑卡出口命中真 IP：${paths.join(', ')}`,
  },
  {
    id: 'dns-leak',
    level: 'critical',
    title: 'DNS 泄漏到本地运营商',
    fix: '切到「全局」档会开启 DNS 劫持；若仍泄漏，检查 dns-hijack 配置是否覆盖 any:53',
    detail: rep => `DNS 出口在 ${rep.isp || '本地运营商'}（AS${rep.asn || '?'}）—— 你解析的域名被本地看到`,
  },
  {
    id: 'interface-bypass',
    level: 'critical',
    title: '绑物理网卡可绕过 TUN',
    fix: '开启 TUN 严格路由；根治需 WFP kill-switch（见 README）',
    detail: ip => `绑定物理网卡能直连出网（拿到 ${ip}）—— 绑卡程序随时会暴露真 IP`,
  },
  {
    id: 'machine-traffic',
    level: 'critical',
    title: '有进程在绕过代理直连',
    fix: '这些进程不受代理保护。可在防火墙里单独禁它们的出站，或用 TUN 强制接管',
    detail: list => `${list} 正在直连 —— 它们的流量不受代理保护`,
  },
  {
    id: 'tun-off',
    level: 'critical',
    title: 'TUN 未开启',
    fix: '切到「全局」档会自动开启 TUN',
    detail: () => 'TUN 关闭时整机流量不走代理，只有手动配了代理的程序才受保护',
  },
  {
    id: 'system-resolver',
    level: 'high',
    title: '系统解析未走 fake-ip',
    fix: '切到「全局」档会开启 fake-ip，系统解析不再拿到真实地址',
    detail: ip => `系统解析得到真实地址 ${ip} —— 域名可能被本地运营商看到`,
  },
  {
    id: 'strict-route-off',
    level: 'high',
    title: '严格路由未开启',
    fix: '在加固项里勾选「强制 TUN 严格路由」',
    detail: () => 'strict-route 关闭时绑卡流量可以绕过 TUN',
  },
  {
    id: 'fake-ip-off',
    level: 'warn',
    title: 'fake-ip 未生效',
    fix: '在加固项里确认 DNS 是 fake-ip 模式',
    detail: () => '没有 fake-ip，DNS 解析结果可能是真实地址',
  },
]

/**
 * 按探针结果生成命中的泄漏因素。
 *
 * @param {object} input
 * @param {string[]} input.exposedPaths 等于真 IP 的出口路径（system/proxy/bound）
 * @param {object|null} input.dnsLeak DNS 泄漏结论（judgeDnsLeak 的返回值）
 * @param {object|null} input.dnsIdentity DNS 出口的身份（AS/ISP）
 * @param {object|null} input.interfaceBypass probeInterfaceBypass 的返回值
 * @param {object|null} input.machineTraffic probeMachineTraffic 的返回值
 * @param {boolean} input.tunEnabled
 * @param {boolean} input.strictRoute
 * @param {boolean} input.fakeIpActive
 * @param {object|null} input.systemResolver probeSystemResolver 的返回值
 */
export function collectLeakFactors(input) {
  const hits = []
  const push = (id, detail) => {
    const factor = LEAK_FACTORS.find(f => f.id === id)
    if (factor !== undefined) {
      hits.push({ id, level: factor.level, title: factor.title, detail, fix: factor.fix ?? '' })
    }
  }

  if (Array.isArray(input.exposedPaths) && input.exposedPaths.length > 0) {
    push('egress-equals-real', `命中路径：${input.exposedPaths.join(', ')}`)
  }

  if (input.dnsLeak !== null && input.dnsLeak !== undefined && input.dnsLeak.leaked === true) {
    push('dns-leak', input.dnsLeak.detail)
  }

  if (input.interfaceBypass !== null && input.interfaceBypass !== undefined && input.interfaceBypass.bypassable === true) {
    push('interface-bypass', input.interfaceBypass.detail ?? '绑定物理网卡能出网')
  }

  if (input.machineTraffic !== null && input.machineTraffic !== undefined
    && Array.isArray(input.machineTraffic.processes) && input.machineTraffic.processes.length > 0) {
    const names = input.machineTraffic.processes
      .map(p => `${p.name}(${p.count})`)
      .slice(0, 5)
      .join(', ')
    push('machine-traffic', names)
  }

  if (input.tunEnabled === false) push('tun-off', 'TUN 关闭')
  if (input.strictRoute === false) push('strict-route-off', 'strict-route 关闭')
  if (input.fakeIpActive === false) push('fake-ip-off', 'fake-ip 未生效')

  if (input.systemResolver !== null && input.systemResolver !== undefined
    && input.systemResolver.leaked === true) {
    push('system-resolver', input.systemResolver.detail ?? '系统解析得到真实地址')
  }

  return hits
}

/**
 * 由命中的因素决定指示灯的颜色与结论。
 *
 * **关键设计**：只要有任何 critical 因素，就是红色。
 * 绿（安全）必须满足「一个泄漏因素都没有」—— 宁可报红也不给假绿。
 *
 * @param {object[]} factors collectLeakFactors 的返回值
 * @param {object} context 额外上下文（是否已校准、是否测到出口）
 */
export function verdictFromFactors(factors, context) {
  const ctx = context ?? {}
  if (ctx.calibrated !== true) {
    return { verdict: 'uncalibrated', tone: 'unknown', reason: '还没有校准真 IP，无法判断是否暴露' }
  }
  const critical = factors.filter(f => f.level === 'critical')
  const high = factors.filter(f => f.level === 'high')
  const warn = factors.filter(f => f.level === 'warn')

  if (critical.length > 0) {
    return {
      verdict: 'leaking',
      tone: 'off',
      reason: critical.map(f => f.title).join('；'),
      fixes: critical.map(f => f.fix).filter(Boolean),
    }
  }
  if (high.length > 0) {
    return {
      verdict: 'risky',
      tone: 'off',
      reason: high.map(f => f.title).join('；'),
      fixes: high.map(f => f.fix).filter(Boolean),
    }
  }
  if (warn.length > 0) {
    return {
      verdict: 'weak',
      tone: 'warn',
      reason: warn.map(f => f.title).join('；'),
      fixes: warn.map(f => f.fix).filter(Boolean),
    }
  }
  if (ctx.egressOk !== true) {
    return { verdict: 'no-egress', tone: 'idle', reason: '三条出口路径都没测通' }
  }
  return { verdict: 'safe', tone: 'on', reason: '没有任何泄漏因素' }
}
