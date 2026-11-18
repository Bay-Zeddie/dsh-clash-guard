/**
 * mihomo external-controller 传输层。
 *
 * 支持两种载体：
 *  - **命名管道**（Clash Verge Rev 默认）：讲 HTTP/1.1 over `\\.\pipe\<name>`。
 *  - **TCP**（显式 `external-controller: host:port`）：普通 HTTP。
 *
 * 两条路径共享同一套响应解析（含 chunked 解码），调用方只见
 * `{ ok, status, text }`。
 *
 * @module dsh-clash-guard/mihomo
 */
import net from 'node:net'
import http from 'node:http'

/** 解 chunked 体。 */
function dechunk(buffer) {
  const parts = []
  let rest = buffer
  for (;;) {
    const nl = rest.indexOf('\r\n')
    if (nl < 0) break
    const size = parseInt(rest.subarray(0, nl).toString('utf8').trim(), 16)
    if (!Number.isFinite(size) || size <= 0) break
    parts.push(rest.subarray(nl + 2, nl + 2 + size))
    rest = rest.subarray(nl + 2 + size + 2)
  }
  return Buffer.concat(parts)
}

/**
 * 解析原始 HTTP 响应。
 * @param {Buffer} raw
 * @returns {{status: number, text: string, headers: string}}
 */
export function parseResponse(raw) {
  const sep = raw.indexOf('\r\n\r\n')
  const head = sep < 0 ? raw.toString('utf8') : raw.subarray(0, sep).toString('utf8')
  let body = sep < 0 ? Buffer.alloc(0) : raw.subarray(sep + 4)
  const statusLine = head.split('\r\n')[0] ?? ''
  const status = Number(statusLine.split(' ')[1] ?? '0') || 0
  if (/transfer-encoding:\s*chunked/i.test(head)) body = dechunk(body)
  return { status, text: body.toString('utf8'), headers: head }
}

/** 组一条请求头。 */
function buildHead(method, target, secret, body) {
  let head = `${method} ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n`
  if (secret !== '') head += `Authorization: Bearer ${secret}\r\n`
  if (body !== undefined) {
    head += 'Content-Type: application/json\r\n'
    head += `Content-Length: ${Buffer.byteLength(body)}\r\n`
  }
  return `${head}\r\n`
}

/**
 * 命名管道请求。
 * @param {object} options
 * @returns {Promise<{ok: boolean, status: number, text: string, error?: string}>}
 */
export function pipeRequest(options) {
  const { pipe, method, target, body, secret, timeoutMs } = options
  return new Promise((resolve) => {
    const socket = net.connect({ path: `\\\\.\\pipe\\${pipe}` })
    const chunks = []
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      try { socket.destroy() } catch { /* already gone */ }
      resolve(value)
    }
    socket.on('connect', () => {
      try {
        socket.write(buildHead(method, target, secret, body) + (body ?? ''))
      } catch (error) {
        finish({ ok: false, status: 0, text: '', error: error.message })
      }
    })
    socket.on('data', chunk => chunks.push(chunk))
    socket.on('error', error => finish({ ok: false, status: 0, text: '', error: error.message }))
    socket.on('end', () => {
      const { status, text } = parseResponse(Buffer.concat(chunks))
      finish({ ok: status >= 200 && status < 300, status, text })
    })
    setTimeout(() => finish({ ok: false, status: 0, text: '', error: 'timeout' }), timeoutMs)
  })
}

/**
 * TCP 请求。
 * @param {object} options
 * @returns {Promise<{ok: boolean, status: number, text: string, error?: string}>}
 */
export function tcpRequest(options) {
  const { host, port, method, target, body, secret, timeoutMs } = options
  return new Promise((resolve) => {
    const headers = {}
    if (secret !== '') headers.authorization = `Bearer ${secret}`
    if (body !== undefined) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = String(Buffer.byteLength(body))
    }
    const req = http.request({ host, port, method, path: target, headers, timeout: timeoutMs }, (res) => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        const status = res.statusCode ?? 0
        resolve({ ok: status >= 200 && status < 300, status, text: Buffer.concat(chunks).toString('utf8') })
      })
    })
    req.on('error', error => resolve({ ok: false, status: 0, text: '', error: error.message }))
    req.on('timeout', () => {
      req.destroy()
      resolve({ ok: false, status: 0, text: '', error: 'timeout' })
    })
    if (body !== undefined) req.write(body)
    req.end()
  })
}

/**
 * 发一条控制器请求（按 target.transport 自动选载体）。
 * @param {object} target discover() 的返回值
 * @param {string} method
 * @param {string} apiPath 形如 `/configs`
 * @param {unknown} [jsonBody]
 * @param {number} [timeoutMs]
 */
export async function request(target, method, apiPath, jsonBody, timeoutMs) {
  const body = jsonBody === undefined ? undefined : JSON.stringify(jsonBody)
  const timeout = Number(timeoutMs ?? target.requestTimeoutMs ?? 0) || 8000
  if (target.transport === 'pipe' && target.pipe !== '') {
    return pipeRequest({
      pipe: target.pipe, method, target: apiPath, body, secret: target.secret, timeoutMs: timeout,
    })
  }
  if (target.transport === 'tcp' && target.port > 0) {
    return tcpRequest({
      host: target.host, port: target.port, method, target: apiPath, body,
      secret: target.secret, timeoutMs: timeout,
    })
  }
  return {
    ok: false,
    status: 0,
    text: '',
    error: 'no controller transport (no pipe discovered, no external-controller configured)',
  }
}

/** GET 并解析 JSON。 */
export async function getJson(target, apiPath, timeoutMs) {
  const res = await request(target, 'GET', apiPath, undefined, timeoutMs)
  if (!res.ok) {
    throw new Error(`${apiPath} -> ${res.status || res.error}: ${String(res.text).slice(0, 200)}`)
  }
  return res.text === '' ? null : JSON.parse(res.text)
}

/** 存活探测：拿到版本号就算通。 */
export async function probe(target) {
  try {
    const version = await getJson(target, '/version', target.requestTimeoutMs)
    return { ok: true, version: String(version?.version ?? ''), meta: version?.meta === true }
  } catch (error) {
    return { ok: false, error: String(error.message ?? error) }
  }
}

/**
 * 取全部代理节点。
 *
 * **形状差异**：mihomo v1.19 的 `GET /proxies` 回 `{ proxies: { name: {...} } }`，
 * 老版本直接回 `{ name: {...} }`。两种都接受——只认一种会在另一种上静默丢字段。
 *
 * @param {object} target
 * @returns {Promise<Record<string, object>>} name → 节点信息
 */
export async function getProxies(target) {
  const payload = await getJson(target, '/proxies')
  if (payload === null || typeof payload !== 'object') return {}
  const nested = payload.proxies
  if (nested !== null && typeof nested === 'object' && !Array.isArray(nested)) {
    return nested
  }
  return payload
}

/**
 * 读单个节点的延迟与存活状态。
 *
 * 延迟有三个来源，按可信度取：
 *   1. `history` 最后一条（mihomo 自己测的）
 *   2. `extra.<testUrl>.history` 最后一条（按测试 URL 分桶的）
 *   3. 都没有就是 0 / 未知
 *
 * @param {object|undefined} entry 节点信息
 * @returns {{delay: number, alive: boolean, type: string}}
 */
export function nodeHealth(entry) {
  const info = entry ?? {}
  const type = String(info.type ?? '')
  const alive = info.alive === true

  const lastOf = (history) => {
    if (!Array.isArray(history) || history.length === 0) return null
    return history[history.length - 1]
  }

  let last = lastOf(info.history)
  if (last === null && info.extra !== null && typeof info.extra === 'object') {
    for (const bucket of Object.values(info.extra)) {
      const candidate = lastOf(bucket?.history)
      if (candidate !== null) {
        last = candidate
        break
      }
    }
  }

  return {
    delay: Number(last?.delay ?? 0),
    alive,
    type,
  }
}
