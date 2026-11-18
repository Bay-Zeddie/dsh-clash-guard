/**
 * 配置快照 —— 把「API 说的」和「配置文件写的」合成一份。
 *
 * **关键事实**：mihomo 的 `GET /configs` 只回一部分字段。实测
 * v1.19.33 的响应里没有 `dns` 段，`tun` 段也没有 `strict-route`。
 * 只信 API 会把「DNS 劫持没配」误报成「配了但读不到」，反过来也会
 * 把「实际开着」漏报成「没开」。
 *
 * 所以审计读两份：
 *   - **API**（`/configs`）：运行时的真相，TUN 开关、auto-route、mixed-port、mode；
 *   - **配置文件**（内核真正在用的 `runtime/config.yaml`）：API 不回的那些段，
 *     dns、strict-route、stack 等。
 *
 * 合并规则：API 有值就用 API（运行时真相优先），没有就落到配置文件，
 * 并在结果里标出每个字段的来源，便于排障时知道该看哪里。
 *
 * @module dsh-clash-guard/snapshot
 */
import fs from 'node:fs'
import path from 'node:path'
import { getJson } from './mihomo.js'
import { topScalar } from './discover.js'

/** 读文本，失败返回 ''。 */
function readText(file) {
  try {
    // **必须规范化 CRLF**：Clash Verge 在 Windows 上写的是 CRLF，而
    // `^key:\s*$` 里的 `$` 在 `\r\n` 之前匹配不到（行尾还剩一个 `\r`），
    // 于是所有块解析静默返回空 —— 表现是「DNS 配置读不到」。
    return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  } catch {
    return ''
  }
}

/**
 * 从 YAML 里取某个块下的标量（缩进感知）。
 *
 * 只做两件事：找到 `<block>:` 行，然后在它之后的更深缩进里找 `<key>: value`。
 * 不做完整 YAML 解析——那需要依赖，而这里要读的字段形状固定。
 *
 * @param {string} text
 * @param {string} block 顶层块名
 * @param {string} key 块内键名
 * @returns {string} 值；找不到返回 ''
 */
export function blockScalar(text, block, key) {
  const blockRe = new RegExp(`^${block.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*$`, 'm')
  const m = blockRe.exec(text)
  if (m === null) return ''
  const start = m.index + m[0].length
  const lines = text.slice(start).split('\n')
  const keyRe = new RegExp(`^\\s+${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*(.*)$`)
  for (const line of lines) {
    // 回到顶层（无缩进的非空行）就说明块结束了
    if (/^\S/.test(line) && line.trim() !== '') break
    const hit = keyRe.exec(line)
    if (hit === null) continue
    let value = hit[1].trim()
    const hash = value.indexOf(' #')
    if (hash >= 0) value = value.slice(0, hash).trim()
    if (
      (value.startsWith("'") && value.endsWith("'"))
      || (value.startsWith('"') && value.endsWith('"'))
    ) {
      value = value.slice(1, -1)
    }
    return value
  }
  return ''
}

/**
 * 从 YAML 里取某个块下的数组（`- item` 形式）。
 * @param {string} text
 * @param {string} block
 * @param {string} key
 * @returns {string[]}
 */
export function blockArray(text, block, key) {
  const blockRe = new RegExp(`^${block.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*$`, 'm')
  const m = blockRe.exec(text)
  if (m === null) return []
  const start = m.index + m[0].length
  const lines = text.slice(start).split('\n')
  const keyRe = new RegExp(`^(\\s+)${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:\\s*$`)
  let collecting = false
  let keyIndent = 0
  const out = []
  for (const line of lines) {
    if (/^\S/.test(line) && line.trim() !== '') break
    if (!collecting) {
      const hit = keyRe.exec(line)
      if (hit === null) continue
      collecting = true
      keyIndent = hit[1].length
      continue
    }
    const indent = line.length - line.trimStart().length
    const item = /^\s*-\s*(.+)$/.exec(line)
    if (item !== null && indent >= keyIndent) {
      let value = item[1].trim()
      if (
        (value.startsWith("'") && value.endsWith("'"))
        || (value.startsWith('"') && value.endsWith('"'))
      ) {
        value = value.slice(1, -1)
      }
      out.push(value)
      continue
    }
    if (line.trim() === '') continue
    break
  }
  return out
}

/** 解析布尔值。 */
function asBool(value) {
  const lower = String(value ?? '').trim().toLowerCase()
  if (lower === 'true') return true
  if (lower === 'false') return false
  return undefined
}

/** 解析数字。 */
function asNumber(value) {
  const num = Number(String(value ?? '').trim())
  return Number.isFinite(num) ? num : undefined
}

/**
 * 生成配置快照。
 *
 * @param {object} options
 * @param {object} options.target 控制器目标（含 modeFile、runtimeDirs）
 * @param {object} options.config 完整插件配置
 * @returns {Promise<object>} 合并后的快照 + 每个字段的来源
 */
export async function takeSnapshot(options) {
  const { target, config } = options
  const api = await getJson(target, '/configs')

  // 配置文件候选：运行目录里的那份是内核真正在用的
  const runtimeName = config.discovery.runtimeConfigName
  const runtimeFiles = (target.runtimeDirs ?? []).map(dir => path.join(dir, runtimeName))
  const files = [...runtimeFiles, target.modeFile].filter(f => typeof f === 'string' && f !== '')
  let yaml = ''
  let yamlFile = ''
  for (const file of files) {
    const text = readText(file)
    if (text !== '') {
      yaml = text
      yamlFile = file
      break
    }
  }

  const sources = {}

  /** API 优先，配置文件兜底。 */
  const pick = (id, apiValue, yamlValue) => {
    if (apiValue !== undefined && apiValue !== null) {
      sources[id] = 'api'
      return apiValue
    }
    if (yamlValue !== undefined && yamlValue !== null && yamlValue !== '') {
      sources[id] = 'file'
      return yamlValue
    }
    sources[id] = 'missing'
    return undefined
  }

  const tunApi = api.tun ?? {}
  const dnsApi = api.dns ?? {}

  const snapshot = {
    yamlFile,
    sources,

    mode: pick('mode', api.mode, topScalar(yaml, 'mode')),
    mixedPort: pick('mixedPort', asNumber(api['mixed-port']), asNumber(topScalar(yaml, 'mixed-port'))),
    allowLan: pick('allowLan', asBool(api['allow-lan']), asBool(topScalar(yaml, 'allow-lan'))),
    ipv6: pick('ipv6', asBool(api.ipv6), asBool(topScalar(yaml, 'ipv6'))),
    logLevel: pick('logLevel', api['log-level'], topScalar(yaml, 'log-level')),

    tun: {
      enable: pick('tun.enable', asBool(tunApi.enable), asBool(blockScalar(yaml, 'tun', 'enable'))),
      stack: pick('tun.stack', tunApi.stack, blockScalar(yaml, 'tun', 'stack')),
      autoRoute: pick('tun.auto-route', asBool(tunApi['auto-route']), asBool(blockScalar(yaml, 'tun', 'auto-route'))),
      strictRoute: pick('tun.strict-route', asBool(tunApi['strict-route']), asBool(blockScalar(yaml, 'tun', 'strict-route'))),
      autoDetectInterface: pick(
        'tun.auto-detect-interface',
        asBool(tunApi['auto-detect-interface']),
        asBool(blockScalar(yaml, 'tun', 'auto-detect-interface')),
      ),
      device: pick('tun.device', tunApi.device, blockScalar(yaml, 'tun', 'device')),
      dnsHijack: pick('tun.dns-hijack', Array.isArray(tunApi['dns-hijack']) ? tunApi['dns-hijack'] : undefined, blockArray(yaml, 'tun', 'dns-hijack')),
    },

    dns: {
      enable: pick('dns.enable', asBool(dnsApi.enable), asBool(blockScalar(yaml, 'dns', 'enable'))),
      enhancedMode: pick('dns.enhanced-mode', dnsApi['enhanced-mode'], blockScalar(yaml, 'dns', 'enhanced-mode')),
      fakeIpRange: pick('dns.fake-ip-range', dnsApi['fake-ip-range'], blockScalar(yaml, 'dns', 'fake-ip-range')),
      // dns-hijack 在 mihomo 里挂在 tun 段下，不是 dns 段；两处都找
      hijack: pick(
        'dns.hijack',
        Array.isArray(dnsApi['dns-hijack']) ? dnsApi['dns-hijack'] : undefined,
        blockArray(yaml, 'tun', 'dns-hijack'),
      ),
      listen: pick('dns.listen', dnsApi.listen, blockScalar(yaml, 'dns', 'listen')),
    },
  }

  return snapshot
}
