/**
 * 出口身份画像 + DNS 泄漏检测。
 *
 * 为什么需要这个模块：
 *
 * 插件原来只比较「出口 IP ≠ 真 IP」。但**IP 不同不等于身份隐藏**：
 *   · 同一家 ISP 的另一个 IP —— IP 变了，运营商还是你
 *   · 同一个国家/城市的机房 —— IP 变了，地理定位还是你
 *   · DNS 走本地运营商 —— 出口 IP 是越南，DNS 出口还是中国移动
 *
 * 业界标准做法（ipleak.net / dnsleaktest.com / browserleaks）分两路：
 *   1. **出口身份**：查 IP 的 AS 号 / ISP 名 / 国家，与真 IP 的身份对比
 *   2. **DNS 泄漏**：查 DNS 解析器的出口 IP，看它是否还在本地运营商
 *
 * 本模块只做只读探测，不改任何系统状态。
 */

/** 从 ipleak.net 的 JSON 提取出口身份。字段名见其公开 API。 */
export function identityOf(payload) {
  if (payload === null || typeof payload !== 'object') return null
  const ip = typeof payload.ip === 'string' ? payload.ip : ''
  if (ip === '') return null
  return {
    ip,
    asn: Number.isFinite(Number(payload.as_number)) ? Number(payload.as_number) : 0,
    isp: String(payload.isp_name ?? ''),
    network: String(payload.as_network ?? ''),
    countryCode: String(payload.country_code ?? ''),
    countryName: String(payload.country_name ?? ''),
    continentCode: String(payload.continent_code ?? ''),
    timeZone: String(payload.time_zone ?? ''),
  }
}

/**
 * 对比两个身份，判定「是否真的换了身份」。
 *
 * 返回分级结论，而不是简单的 true/false —— 用户需要知道差多少：
 *   hidden    AS 号与真 IP 不同（换了运营商，最强隐藏）
 *   same-asn  IP 变了但 AS 号相同（同一家 ISP 的另一个 IP，弱隐藏）
 *   same-country  AS 不同但国家相同（换了运营商，地理没换）
 *   exposed   IP 与真 IP 完全相同
 *   unknown   缺少任一侧数据
 *
 * @param {object|null} egress 当前出口身份
 * @param {object|null} real   真 IP 身份（校准时的基线）
 */
export function compareIdentity(egress, real) {
  if (egress === null || real === null) {
    return { level: 'unknown', detail: '缺少出口或真 IP 的身份数据' }
  }
  if (egress.ip === real.ip) {
    return { level: 'exposed', detail: '出口 IP 与真 IP 完全相同 —— 代理没有生效' }
  }
  const sameAsn = egress.asn > 0 && real.asn > 0 && egress.asn === real.asn
  const sameCountry = egress.countryCode !== '' && egress.countryCode === real.countryCode

  if (sameAsn) {
    return {
      level: 'same-asn',
      detail: `IP 变了但运营商相同（AS${egress.asn} ${egress.isp}）—— 同一条出口链路`,
    }
  }
  if (sameCountry) {
    return {
      level: 'same-country',
      detail: `运营商已换（AS${real.asn} → AS${egress.asn}）但国家相同（${egress.countryName}）`,
    }
  }
  return {
    level: 'hidden',
    detail: `运营商与国家都已改变（AS${real.asn} ${real.isp} → AS${egress.asn} ${egress.isp}，`
      + `${real.countryName} → ${egress.countryName}）`,
  }
}

/**
 * 从 DNS 查询应答里提取解析器出口 IP。
 *
 * 手法来自 dnsleaktest：查一个会回显来源的域名。
 *   · `o-o.myaddr.l.google.com` TXT —— Google 回显 EDNS Client Subnet 与解析器 IP
 *   · `whoami.akamai.net` A —— Akamai 回显解析器 IP
 *
 * 返回去重后的 IP 列表（已排除明显的网段声明，如 `111.0.116.0` 这类 ECS 前缀）。
 */
export function dnsEgressIps(answerText, excludeCidrPrefixes) {
  const text = String(answerText ?? '')
  const found = []
  const re = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/g
  let match
  while ((match = re.exec(text)) !== null) {
    const ip = match[1]
    if (ip === '0.0.0.0') continue
    // EDNS Client Subnet 会给一个网段前缀（末位 .0），那不是解析器 IP
    if (ip.endsWith('.0')) continue
    if (!found.includes(ip)) found.push(ip)
  }
  if (Array.isArray(excludeCidrPrefixes)) {
    return found.filter(ip => !excludeCidrPrefixes.some(prefix => ip.startsWith(prefix)))
  }
  return found
}

/**
 * 判定 DNS 是否泄漏。
 *
 * 逻辑：
 *   · DNS 出口 IP 与代理出口 IP 同一 AS → 没泄漏（DNS 也走了代理）
 *   · DNS 出口 IP 与真 IP 同一 AS → 泄漏（DNS 还在本地运营商）
 *   · 都无法判断 → unknown（不能瞎猜，宁可说不知道）
 *
 * @param {string[]} dnsIps DNS 出口 IP 列表
 * @param {object|null} egress 代理出口身份
 * @param {object|null} real 真 IP 身份
 */
/**
 * 运营商归属归一化。
 *
 * 同一家运营商会有多个 AS 号：真机实测中国移动同时有
 * AS56041（CMNET-Zhejiang-AP，省网）与 AS9808（CHINAMOBILE-CN，集团）。
 * 只比 AS 相等会把「同一家运营商的两个 AS」误判成不同运营商 ——
 * 那会漏报真实泄漏。这里按 ISP 名的关键词归类。
 *
 * 返回归一化后的家族标识；识别不出就返回空串（不做猜测）。
 */
export function ispFamily(identity) {
  if (identity === null || typeof identity !== 'object') return ''
  const text = `${identity.isp ?? ''} ${identity.network ?? ''}`.toLowerCase()
  if (text.includes('china mobile') || text.includes('chinamobile') || text.includes('cmnet')) return 'china-mobile'
  if (text.includes('china unicom') || text.includes('chinaunicom') || text.includes('cucc')) return 'china-unicom'
  if (text.includes('china telecom') || text.includes('chinatelecom') || text.includes('chinanet')) return 'china-telecom'
  if (text.includes('china education') || text.includes('cernet')) return 'china-education'
  if (text.includes('china broadcasting') || text.includes('cbn')) return 'china-broadcast'
  return ''
}

export function judgeDnsLeak(dnsIps, egress, real, dnsIdentities) {
  if (!Array.isArray(dnsIps) || dnsIps.length === 0) {
    return { leaked: null, level: 'unknown', detail: '没有取到 DNS 出口 IP' }
  }
  // 第一优先：DNS 出口 IP 直接等于某个已知出口 —— 确凿
  const sameAsEgress = egress !== null && egress.ip !== '' && dnsIps.includes(egress.ip)
  const sameAsReal = real !== null && real.ip !== '' && dnsIps.includes(real.ip)
  if (sameAsEgress) {
    return { leaked: false, level: 'clean', detail: `DNS 出口 ${egress.ip} 与代理出口一致` }
  }
  if (sameAsReal) {
    return { leaked: true, level: 'leaked', detail: `DNS 出口 ${real.ip} 是真 IP —— DNS 没有走代理` }
  }

  // 第二优先：DNS 出口 IP 的 **AS 号**与真 IP 的 AS 相同 → 仍是本地运营商，泄漏
  // DNS 出口 IP 每次都可能是运营商池里的不同地址（真机见过 111.1.165.55、
  // 117.135.171.52 轮换），只比 IP 相等会永远判不出来。
  if (Array.isArray(dnsIdentities)) {
    const dnsAsns = dnsIdentities
      .filter(x => x !== null && typeof x === 'object' && Number.isFinite(x.asn) && x.asn > 0)
      .map(x => x.asn)
    if (dnsAsns.length > 0) {
      const egressAsn = egress !== null && Number.isFinite(egress.asn) ? egress.asn : 0
      const realAsn = real !== null && Number.isFinite(real.asn) ? real.asn : 0
      if (egressAsn > 0 && dnsAsns.every(a => a === egressAsn)) {
        return { leaked: false, level: 'clean', detail: `DNS 出口 AS${egressAsn} 与代理出口同一运营商` }
      }
      // 同一家运营商会有多个 AS（中国移动 AS56041 省网 / AS9808 集团），
      // 所以再按运营商家族比一次，否则真实泄漏会被漏报。
      const egressFamily = ispFamily(egress)
      const realFamily = ispFamily(real)
      const dnsFamilies = dnsIdentities
        .filter(x => x !== null && typeof x === 'object')
        .map(x => ispFamily(x))
        .filter(f => f !== '')
      if (egressFamily !== '' && dnsFamilies.length > 0 && dnsFamilies.every(f => f === egressFamily)) {
        return { leaked: false, level: 'clean', detail: `DNS 出口与代理出口同属 ${egressFamily}` }
      }
      if (realFamily !== '' && dnsFamilies.some(f => f === realFamily)) {
        const hit = dnsIdentities.find(x => x !== null && ispFamily(x) === realFamily)
        return {
          leaked: true,
          level: 'leaked',
          detail: `DNS 出口在本地运营商 ${hit?.isp ?? realFamily}（AS${hit?.asn ?? '?'}）—— DNS 没有走代理，真实地区已暴露`,
        }
      }
      if (realAsn > 0 && dnsAsns.some(a => a === realAsn)) {
        const hit = dnsIdentities.find(x => x !== null && x.asn === realAsn)
        return {
          leaked: true,
          level: 'leaked',
          detail: `DNS 出口在本地运营商 AS${realAsn} ${hit?.isp ?? ''} —— DNS 没有走代理，真实地区已暴露`,
        }
      }
    }
  }

  return {
    leaked: null,
    level: 'uncertain',
    detail: `DNS 出口 ${dnsIps.join(', ')} 既不是代理出口也不在真 IP 的运营商 —— 无法判定，需人工核对`,
  }
}

/**
 * 汇总一份出口画像报告。
 *
 * @param {object} input
 * @param {object|null} input.egressIdentity 代理出口身份
 * @param {object|null} input.realIdentity 真 IP 身份
 * @param {string[]} input.dnsIps DNS 出口 IP
 * @param {boolean} input.fakeIpActive fake-ip 是否生效
 */
export function buildReport(input) {
  const identity = compareIdentity(input.egressIdentity ?? null, input.realIdentity ?? null)
  const dns = judgeDnsLeak(
    input.dnsIps ?? [],
    input.egressIdentity ?? null,
    input.realIdentity ?? null,
    input.dnsIdentities ?? null,
  )

  // 综合结论：DNS 泄漏比身份弱隐藏更严重（DNS 会暴露你的真实地区与运营商）
  let verdict = 'safe'
  const reasons = []
  if (identity.level === 'exposed') { verdict = 'leaking'; reasons.push(identity.detail) }
  else if (identity.level === 'same-asn' || identity.level === 'same-country') {
    if (verdict !== 'leaking') verdict = 'weak'
    reasons.push(identity.detail)
  } else if (identity.level === 'unknown') {
    if (verdict === 'safe') verdict = 'unknown'
    reasons.push(identity.detail)
  }

  if (dns.leaked === true) { verdict = 'leaking'; reasons.push(dns.detail) }
  else if (dns.level === 'uncertain') {
    if (verdict === 'safe') verdict = 'unknown'
    reasons.push(dns.detail)
  }

  if (input.fakeIpActive !== true && verdict === 'safe') {
    verdict = 'weak'
    reasons.push('fake-ip 未生效 —— 域名解析结果可能被本地运营商看到')
  }

  return {
    verdict,
    identity: { ...identity, egressIp: input.egressIdentity?.ip ?? '', realIp: input.realIdentity?.ip ?? '' },
    dns: { ...dns, ips: input.dnsIps ?? [] },
    fakeIpActive: input.fakeIpActive === true,
    reasons,
  }
}

/**
 * 从 ip-api.com 的应答提取身份。
 *
 * 与 ipleak.net 的字段名不同，这里做一次归一化 —— 两个数据源产出的
 * 身份结构必须一致，否则 compareIdentity 会拿苹果比橘子。
 * ip-api 的 `as` 字段形如 `"AS56041 China Mobile..."`，要剥出数字。
 */
export function ipApiIdentity(payload) {
  if (payload === null || typeof payload !== 'object') return null
  const asField = String(payload.as ?? '')
  const asnMatch = /^AS(\d+)/.exec(asField)
  const countryCode = String(payload.countryCode ?? '')
  if (countryCode === '' && asField === '') return null
  return {
    ip: '',
    asn: asnMatch === null ? 0 : Number(asnMatch[1]),
    isp: String(payload.isp ?? payload.asname ?? ''),
    network: asField,
    countryCode,
    countryName: String(payload.country ?? ''),
    continentCode: '',
    timeZone: '',
  }
}
