/**
 * 把 /ip 路由升级为「全因素泄漏聚合检测」。
 *
 * 原判定只看出口 IP 是否等于真 IP —— 真机实测证明那会给假绿：
 * 出口在越南、运营商换了、国家也换了，但 DNS 出口还在 China Mobile。
 *
 * 新判定：跑全部会暴露身份的因素，任一 critical 命中即报红。
 *
 * 跑法：node tools/upgrade-ip-route.mjs
 */
import fs from 'node:fs'

const FILE = 'lib/http.js'
let s = fs.readFileSync(FILE, 'utf8')

/* ---------------- 1. 替换判定段 ---------------- */

const oldVerdictStart = '        // —— 判定 ——'
const oldVerdictEnd = '        json(res, 200, {'
const startIdx = s.indexOf(oldVerdictStart)
const endIdx = s.indexOf(oldVerdictEnd, startIdx)
if (startIdx < 0 || endIdx < 0) {
  console.error('找不到判定段')
  process.exit(1)
}

const newVerdict = `        // —— 全因素泄漏聚合判定 ——
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
        const safe = (promise, fallback) => promise.catch(() => fallback)
        const [dnsReport, bypassProbe, trafficProbe, resolverProbe] = await Promise.all([
          safe(probeIdentityReport(found.ok === true ? found.target : null, config), null),
          safe(probeInterfaceBypass({ cfg: config.windows, discovery: config.discovery, adapter: adapter.primary, egress: config.egress }), null),
          safe(probeMachineTraffic({ config, mixedPort: Number(snap === null ? 0 : (snap.mixedPort ?? 0)) }), null),
          safe(probeSystemResolver({ cfg: config.windows, discovery: config.discovery, dns: config.leaks.dnsProbeName }), null),
        ])

        const tunEnabled = snap === null ? null : (snap.tun.enable === true)
        const strictRoute = snap === null ? null : (snap.tun.strictRoute === true)
        const fakeIpActive = snap === null
          ? null
          : (snap.dns.enable === true && snap.dns.enhancedMode === 'fake-ip')

        const factors = collectLeakFactors({
          exposedPaths,
          dnsLeak: dnsReport === null ? null : dnsReport.dns,
          dnsIdentity: dnsReport === null ? null : null,
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

        // 控制器不可达时单独降级：整机出口可能还在，但代理侧的结论不可信
        const phase = found.ok === true ? 'ok' : 'unreachable'
        const verdict = decision.verdict
        const tone = decision.tone

`

s = s.slice(0, startIdx) + newVerdict + s.slice(endIdx)

/* ---------------- 2. 响应体加 factors ---------------- */

const oldResponse = `        json(res, 200, {
          ok: verdict !== 'no-egress',
          phase: found.ok === true ? 'ok' : 'unreachable',
          verdict,
          tone,
          realIp,
          exposedPaths,`

const newResponse = `        json(res, 200, {
          ok: verdict !== 'no-egress',
          phase,
          verdict,
          tone,
          // 命中的泄漏因素 —— 悬停提示逐条列出，用户知道到底哪里漏了
          factors,
          reason: decision.reason,
          realIp,
          exposedPaths,`

if (!s.includes(oldResponse)) {
  console.error('找不到响应体')
  process.exit(1)
}
s = s.replace(oldResponse, newResponse)

/* ---------------- 3. 补 imports ---------------- */

const importAnchor = "import { identityOf, ipApiIdentity, dnsEgressIps, buildReport } from './identity.js'"
if (!s.includes(importAnchor)) {
  console.error('找不到 identity import')
  process.exit(1)
}
if (!s.includes("from './leak-factors.js'")) {
  s = s.replace(importAnchor, importAnchor
    + "\nimport { collectLeakFactors, verdictFromFactors } from './leak-factors.js'")
}

fs.writeFileSync(FILE, s, 'utf8')
console.log('✔ /ip 已升级为全因素聚合判定')
