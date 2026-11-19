/**
 * 出口 IP 探测与真 IP 校准。
 *
 * 两条路径，同一个出口形状 `{ok, ip, via, attempts}`：
 *  - `probeViaProxy` 走混合端口（CONNECT 隧道 + TLS），用于验证「代理出口在哪」；
 *  - `probeDirect` 直连，**只在保护关闭时**用于采集真 IP。
 *
 * 端点表、超时、UA 全部来自 defaults.egress。零依赖：手搓 CONNECT + TLS。
 *
 * @module dsh-clash-guard/egress
 */
import http from 'node:http'
import net from 'node:net'
import tls from 'node:tls'

/**
 * 判断一个字符串像不像公网 IP。
 * @param {string} value
 */
export function looksLikeIp(value) {
  const text = String(value ?? '').trim()
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(text)) {
    return text.split('.').every(part => {
      const n = Number(part)
      return Number.isInteger(n) && n >= 0 && n <= 255
    })
  }
  return /^[0-9a-f]{1,4}(:[0-9a-f]{0,4}){2,7}$/i.test(text)
}

/** 解 chunked 体（文本版）。 */
function dechunkText(body) {
  const parts = []
  let rest = body
  for (;;) {
    const nl = rest.indexOf('\r\n')
    if (nl < 0) break
    const size = parseInt(rest.slice(0, nl).trim(), 16)
    if (!Number.isFinite(size) || size <= 0) break
    parts.push(rest.slice(nl + 2, nl + 2 + size))
    rest = rest.slice(nl + 2 + size + 2)
  }
  return parts.join('')
}

/**
 * 通过 HTTP 代理的 CONNECT 隧道取一个 HTTPS URL。
 * @param {object} options
 * @param {string} options.proxyHost
 * @param {number} options.proxyPort
 * @param {string} options.url
 * @param {number} options.timeoutMs
 * @param {string} options.userAgent
 * @returns {Promise<{ok: boolean, status: number, body: string, error?: string}>}
 */
export function fetchViaProxy(options) {
  const { proxyHost, proxyPort, url, timeoutMs, userAgent } = options
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    let target
    try {
      target = new URL(url)
    } catch (error) {
      finish({ ok: false, status: 0, body: '', error: `bad url: ${error.message}` })
      return
    }
    const port = target.port === '' ? 443 : Number(target.port)
    const connectReq = http.request({
      host: proxyHost,
      port: proxyPort,
      method: 'CONNECT',
      path: `${target.hostname}:${port}`,
      timeout: timeoutMs,
    })
    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy()
        finish({ ok: false, status: res.statusCode ?? 0, body: '', error: `proxy CONNECT ${res.statusCode}` })
        return
      }
      const secure = tls.connect({ socket, servername: target.hostname }, () => {
        const reqPath = `${target.pathname}${target.search}` || '/'
        secure.write(
          `GET ${reqPath} HTTP/1.1\r\n`
          + `Host: ${target.hostname}\r\n`
          + `User-Agent: ${userAgent}\r\n`
          + 'Accept: text/plain, */*\r\n'
          + 'Connection: close\r\n\r\n',
        )
      })
      const chunks = []
      secure.on('data', chunk => chunks.push(chunk))
      secure.on('error', error => finish({ ok: false, status: 0, body: '', error: error.message }))
      secure.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        const sep = raw.indexOf('\r\n\r\n')
        const head = sep < 0 ? '' : raw.slice(0, sep)
        const status = Number((head.split('\r\n')[0] ?? '').split(' ')[1] ?? 0) || 0
        let body = sep < 0 ? raw : raw.slice(sep + 4)
        if (/transfer-encoding:\s*chunked/i.test(head)) body = dechunkText(body)
        finish({ ok: status >= 200 && status < 300, status, body: body.trim() })
      })
      setTimeout(() => {
        try { secure.destroy() } catch { /* gone */ }
        finish({ ok: false, status: 0, body: '', error: 'timeout' })
      }, timeoutMs)
    })
    connectReq.on('error', error => finish({ ok: false, status: 0, body: '', error: error.message }))
    connectReq.on('timeout', () => {
      connectReq.destroy()
      finish({ ok: false, status: 0, body: '', error: 'connect timeout' })
    })
    connectReq.end()
  })
}

/**
 * 直连取一个 URL（仅用于「保护关闭时」校准真 IP）。
 *
 * 按协议分流：`https:` 走 tls，`http:` 走明文。只用 http.request 会在
 * https 端点上报 ERR_INVALID_PROTOCOL。
 *
 * @param {object} options
 * @returns {Promise<{ok: boolean, status: number, body: string, error?: string}>}
 */
export function fetchDirect(options) {  const { url, timeoutMs, userAgent } = options
  return new Promise((resolve) => {
    let target
    try {
      target = new URL(url)
    } catch (error) {
      resolve({ ok: false, status: 0, body: '', error: `bad url: ${error.message}` })
      return
    }
    const secure = target.protocol === 'https:'
    const port = target.port === '' ? (secure ? 443 : 80) : Number(target.port)
    const hostname = target.hostname
    const reqPath = `${target.pathname}${target.search}` || '/'

    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }

    const collect = (stream) => {
      const chunks = []
      stream.on('data', chunk => chunks.push(chunk))
      stream.on('error', error => finish({ ok: false, status: 0, body: '', error: error.message }))
      stream.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        const sep = raw.indexOf('\r\n\r\n')
        const head = sep < 0 ? '' : raw.slice(0, sep)
        const status = Number((head.split('\r\n')[0] ?? '').split(' ')[1] ?? 0) || 0
        let body = sep < 0 ? raw : raw.slice(sep + 4)
        if (/transfer-encoding:\s*chunked/i.test(head)) body = dechunkText(body)
        finish({ ok: status >= 200 && status < 300, status, body: body.trim() })
      })
    }

    const request = secure ? tls.connect({ host: hostname, port, servername: hostname }, () => {
      request.write(
        `GET ${reqPath} HTTP/1.1\r\n`
        + `Host: ${target.host}\r\n`
        + `User-Agent: ${userAgent}\r\n`
        + 'Accept: text/plain, */*\r\n'
        + 'Connection: close\r\n\r\n',
      )
    }) : net.connect({ host: hostname, port }, () => {
      request.write(
        `GET ${reqPath} HTTP/1.1\r\n`
        + `Host: ${target.host}\r\n`
        + `User-Agent: ${userAgent}\r\n`
        + 'Accept: text/plain, */*\r\n'
        + 'Connection: close\r\n\r\n',
      )
    })

    request.on('error', error => finish({ ok: false, status: 0, body: '', error: error.message }))
    request.setTimeout(timeoutMs, () => {
      try { request.destroy() } catch { /* gone */ }
      finish({ ok: false, status: 0, body: '', error: 'timeout' })
    })
    collect(request)
  })
}

/**
 * 依次尝试所有端点，返回第一个像 IP 的答案。
 * @param {string[]} endpoints
 * @param {(url: string) => Promise<{ok: boolean, status: number, body: string, error?: string}>} fetcher
 */
/**
 * 并发问全部端点，取第一个像 IP 的答案。
 *
 * **为什么必须并发**：串行时一个不通的端点要等满 `timeoutMs` 才轮到下一个。
 * 实测绑卡路径（TUN 拦死）三个端点串行 = 36 秒，指示灯点一下要等半分钟。
 * 并发后总耗时 ≈ 单个端点超时，即一次 `timeoutMs`。
 *
 * 代价：会同时打三个外部端点。对「查自己 IP」这种低频操作可以接受。
 *
 * @param {string[]} endpoints
 * @param {(url: string) => Promise<{ok: boolean, status: number, body: string, error?: string}>} fetcher
 * @returns {Promise<{ok: boolean, ip: string|null, via: string, attempts: Array<object>}>}
 */
async function firstIp(endpoints, fetcher) {
  if (endpoints.length === 0) return { ok: false, ip: null, via: '', attempts: [] }

  const settled = await Promise.all(endpoints.map(async (url) => {
    try {
      const res = await fetcher(url)
      return { url, ok: res.ok === true, status: res.status ?? 0, body: res.body ?? '', error: res.error }
    } catch (error) {
      return { url, ok: false, status: 0, body: '', error: String(error.message ?? error) }
    }
  }))

  // 按端点原顺序挑第一个合法答案 —— 保持「首选端点优先」的语义，
  // 不让先返回的次选端点抢走结论。
  const winner = settled.find(item => item.ok && looksLikeIp(item.body))
  const attempts = settled.map(item => ({
    url: item.url,
    ok: item.ok,
    status: item.status,
    body: item.body,
    error: item.error,
  }))

  return winner === undefined
    ? { ok: false, ip: null, via: '', attempts }
    : { ok: true, ip: winner.body.trim(), via: winner.url, attempts }
}

/**
 * 走代理取出口 IP。
 * @param {object} options
 * @param {number} options.mixedPort
 * @param {object} options.egress defaults.egress
 * @param {string} options.proxyHost defaults.egress.proxyHost
 */
export async function probeViaProxy(options) {
  const { mixedPort, egress, proxyHost } = options
  const host = proxyHost ?? egress.proxyHost
  if (!Number.isFinite(mixedPort) || mixedPort <= 0) {
    return { ok: false, ip: null, via: '', attempts: [], error: 'mixed port unknown' }
  }
  if (typeof host !== 'string' || host === '') {
    return { ok: false, ip: null, via: '', attempts: [], error: 'proxy host unknown' }
  }
  return firstIp(egress.endpoints, url => fetchViaProxy({
    proxyHost: host,
    proxyPort: mixedPort,
    url,
    timeoutMs: egress.timeoutMs,
    userAgent: egress.userAgent,
  }))
}

/**
 * 直连取真 IP。
 * @param {object} options
 * @param {object} options.egress defaults.egress
 */
export async function probeDirect(options) {
  const { egress } = options
  return firstIp(egress.endpoints, url => fetchDirect({
    url,
    timeoutMs: egress.timeoutMs,
    userAgent: egress.userAgent,
  }))
}

/* ------------------------------------------------------------------ *
 * 整机出口探测 —— 不是「代理能不能出去」，是「这台电脑在用什么 IP 出去」
 * ------------------------------------------------------------------ */

/**
 * 走系统默认路由取出口 IP（不经过代理端口，但**仍可能经过 TUN**）。
 *
 * 这是「用户平时上网时的出口」：浏览器、微信、游戏都走这条路。
 * 如果 TUN 开着，这里拿到的就是节点 IP（好）；TUN 没开但系统代理开着，
 * 这个直连探测会绕过系统代理 —— 所以它反映的是「L3 层出口」。
 *
 * @param {object} options
 * @param {object} options.egress
 * @returns {Promise<object>}
 */
export async function probeSystemEgress(options) {
  const { egress } = options
  const result = await firstIp(egress.endpoints, url => fetchDirect({
    url,
    timeoutMs: egress.timeoutMs,
    userAgent: egress.userAgent,
  }))
  return {
    ok: result.ok === true,
    ip: result.ok === true ? result.ip : '',
    via: result.ok === true ? result.via : '',
    attempts: result.attempts,
  }
}

/**
 * 绑定物理网卡取出口 IP —— **这是最接近「真实 IP」的一条**。
 *
 * 原理：`net.connect({ localAddress: 物理网卡IP })` 强制从这块网卡出去。
 * Windows 上绑源地址会走该地址所属接口（实测无视路由 metric），
 * 所以这条路径**绕开 TUN**，拿到的是运营商分配的出口。
 *
 * 它回答的问题最尖锐：**如果某个程序绑了物理网卡，外面看到的是谁？**
 *
 * @param {object} options
 * @param {string} options.localAddress 物理网卡的 IPv4
 * @param {object} options.egress
 * @returns {Promise<object>}
 */
export async function probeBoundEgress(options) {
  const { localAddress, egress } = options
  if (typeof localAddress !== 'string' || localAddress === '') {
    return { ok: false, ip: '', via: '', detail: '没有物理网卡地址', attempts: [] }
  }
  // 绑卡是最容易不通的一条（TUN 拦死），用更短的超时：
  // 3 秒已经足够区分「被堵住」与「慢」。
  const timeoutMs = Number(egress.boundTimeoutMs ?? 0) || egress.timeoutMs
  const result = await firstIp(egress.endpoints, url => fetchBound({
    url,
    localAddress,
    timeoutMs,
    userAgent: egress.userAgent,
  }))
  return {
    ok: result.ok === true,
    ip: result.ok === true ? result.ip : '',
    via: result.ok === true ? result.via : '',
    detail: result.ok === true ? '' : (result.attempts.map(a => a.error ?? a.status).join(' / ') || '失败'),
    attempts: result.attempts,
  }
}

/**
 * 绑定指定源地址取一个 URL。
 *
 * 与 {@link fetchDirect} 的差别只有一处：`net.connect`/`tls.connect` 带上
 * `localAddress`。这一个参数就决定了包从哪块网卡出去。
 *
 * @param {object} options
 * @returns {Promise<{ok: boolean, status: number, body: string, error?: string}>}
 */
export function fetchBound(options) {
  const { url, localAddress, timeoutMs, userAgent } = options
  return new Promise((resolve) => {
    let target
    try {
      target = new URL(url)
    } catch (error) {
      resolve({ ok: false, status: 0, body: '', error: `bad url: ${error.message}` })
      return
    }
    const secure = target.protocol === 'https:'
    const port = target.port === '' ? (secure ? 443 : 80) : Number(target.port)

    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }

    const write = (socket) => {
      const reqPath = `${target.pathname}${target.search}` || '/'
      socket.write(
        `GET ${reqPath} HTTP/1.1\r\n`
        + `Host: ${target.host}\r\n`
        + `User-Agent: ${userAgent}\r\n`
        + 'Accept: text/plain, */*\r\n'
        + 'Connection: close\r\n\r\n',
      )
    }

    let socket
    try {
      socket = secure
        ? tls.connect({ host: target.hostname, port, servername: target.hostname, localAddress }, () => write(socket))
        : net.connect({ host: target.hostname, port, localAddress }, () => write(socket))
    } catch (error) {
      finish({ ok: false, status: 0, body: '', error: error.message })
      return
    }

    const chunks = []
    socket.on('data', chunk => chunks.push(chunk))
    socket.on('error', error => finish({ ok: false, status: 0, body: '', error: error.code || error.message }))
    socket.setTimeout(timeoutMs, () => {
      try { socket.destroy() } catch { /* gone */ }
      finish({ ok: false, status: 0, body: '', error: 'timeout' })
    })
    socket.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      const sep = raw.indexOf('\r\n\r\n')
      const head = sep < 0 ? '' : raw.slice(0, sep)
      const status = Number((head.split('\r\n')[0] ?? '').split(' ')[1] ?? 0) || 0
      let body = sep < 0 ? raw : raw.slice(sep + 4)
      if (/transfer-encoding:\s*chunked/i.test(head)) body = dechunkText(body)
      finish({ ok: status >= 200 && status < 300, status, body: body.trim() })
    })
  })
}

/* ------------------------------------------------------------------ *
 * 出口身份画像 —— IP 不同不等于身份隐藏
 * ------------------------------------------------------------------ */

/**
 * 走代理查出口的**身份**（AS 号 / ISP / 国家）。
 *
 * 只看 IP 不同是不够的：同一家 ISP 的另一个 IP，运营商还是你；
 * 同一个国家另一个机房，地理定位还是你。ipleak.net 的公开 JSON API
 * 一次返回 AS 号、ISP 名、国家、时区 —— 这是判断「身份是否真换」的
 * 业界标准数据源（ipleak.net / browserleaks 同源）。
 *
 * @param {object} options
 * @param {number} options.mixedPort 混合端口
 * @param {object} options.egress defaults.egress
 */
export async function probeIdentity(options) {
  const { mixedPort, egress, proxyHost } = options
  const host = proxyHost ?? egress.proxyHost
  const endpoint = egress.identityEndpoint
  if (typeof endpoint !== 'string' || endpoint === '') {
    return { ok: false, payload: null, error: 'identity endpoint 未配置' }
  }
  if (!Number.isFinite(mixedPort) || mixedPort <= 0) {
    return { ok: false, payload: null, error: 'mixed port unknown' }
  }
  const result = await fetchViaProxy({
    proxyHost: host,
    proxyPort: mixedPort,
    url: endpoint,
    timeoutMs: egress.timeoutMs,
    userAgent: egress.userAgent,
  })
  if (result.ok !== true || typeof result.body !== 'string') {
    return { ok: false, payload: null, error: result.error ?? 'fetch failed' }
  }
  try {
    return { ok: true, payload: JSON.parse(result.body), error: '' }
  } catch {
    return { ok: false, payload: null, error: 'JSON 解析失败' }
  }
}

/**
 * 反查任意 IP 的身份（AS / ISP / 国家）。
 *
 * 用途：真 IP 是校准时存下来的**历史值**，我们没法再"直连探测"它 ——
 * 直连探测拿到的是当前出口，不是那个 IP。所以要反查。
 * ip-api.com 免费、无需 key、支持任意 IP。
 *
 * @param {object} options
 * @param {string} options.ip 要查的 IP
 * @param {object} options.egress defaults.egress
 */
export async function lookupIdentity(options) {
  const { ip, egress } = options
  const template = egress.lookupEndpoint
  if (typeof template !== 'string' || template === '') {
    return { ok: false, payload: null, error: 'lookup endpoint 未配置' }
  }
  if (typeof ip !== 'string' || !looksLikeIp(ip)) {
    return { ok: false, payload: null, error: '不是合法 IP' }
  }
  const url = template.replace('{ip}', encodeURIComponent(ip))
  const result = await fetchDirect({ url, timeoutMs: egress.timeoutMs, userAgent: egress.userAgent })
  if (result.ok !== true || typeof result.body !== 'string') {
    return { ok: false, payload: null, error: result.error ?? 'fetch failed' }
  }
  try {
    const payload = JSON.parse(result.body)
    if (payload.status === 'fail') {
      return { ok: false, payload: null, error: String(payload.message ?? 'lookup failed') }
    }
    return { ok: true, payload, error: '' }
  } catch {
    return { ok: false, payload: null, error: 'JSON 解析失败' }
  }
}
