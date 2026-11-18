/**
 * 配置装配 —— 三层覆盖，零字面量。
 *
 *   1. `defaults.json`（包内，唯一的事实来源）
 *   2. `$DSH_HOME/dsh-clash-guard/settings.json`（用户写入）
 *   3. 环境变量 `DSH_CLASH_GUARD_<路径>`（临时覆盖，测试与排障用）
 *
 * 环境变量写法：`__` 表示层级分隔，键名全大写。
 *   `DSH_CLASH_GUARD_PORTS__MIXEDPORT=7897`
 *   `DSH_CLASH_GUARD_CONTROLLER__SECRET=xxx`
 *
 * 所有层都用同一份 defaults 的形状做类型校验：类型不符的覆盖被丢弃，
 * 而不是把一份坏配置带进运行期。
 *
 * @module dsh-clash-guard/settings
 */
import fs from 'node:fs'
import path from 'node:path'
import { readDefaults, settingsFile, ensureDir, stateDir } from './paths.js'

/** 深拷贝（只用 JSON 值，structuredClone 在旧 Node 上没有）。 */
function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

/** 判断是否是普通对象。 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 按模板形状合并：只接受模板里存在的键，且类型必须一致。
 * 数组整体替换（不做逐项合并），因为数组是白名单/端点表这类原子配置。
 * @param {unknown} template
 * @param {unknown} patch
 * @returns {unknown}
 */
export function mergeShaped(template, patch) {
  if (!isPlainObject(template)) {
    if (Array.isArray(template)) {
      return Array.isArray(patch) ? patch.slice() : clone(template)
    }
    if (patch === undefined || patch === null) return template
    return typeof patch === typeof template ? patch : template
  }
  const out = {}
  const source = isPlainObject(patch) ? patch : {}
  for (const key of Object.keys(template)) {
    out[key] = Object.hasOwn(source, key)
      ? mergeShaped(template[key], source[key])
      : clone(template[key])
  }
  return out
}

/** 把 `A__B` 解析成 ['A','B']。 */
function envPath(name, prefix) {
  const tail = name.slice(prefix.length)
  return tail.split('__').map(part => part.toLowerCase())
}

/** 按路径写值。 */
function setAtPath(root, keys, value) {
  let node = root
  for (let i = 0; i < keys.length - 1; i += 1) {
    const key = keys[i]
    if (!isPlainObject(node[key])) return false
    node = node[key]
  }
  const last = keys[keys.length - 1]
  if (!Object.hasOwn(node, last)) return false
  const template = node[last]
  if (Array.isArray(template)) {
    node[last] = value.split(',').map(s => s.trim()).filter(Boolean)
    return true
  }
  if (typeof template === 'boolean') {
    const lower = value.trim().toLowerCase()
    if (lower === 'true' || lower === '1') { node[last] = true; return true }
    if (lower === 'false' || lower === '0') { node[last] = false; return true }
    return false
  }
  if (typeof template === 'number') {
    const num = Number(value)
    if (!Number.isFinite(num)) return false
    node[last] = num
    return true
  }
  if (typeof template === 'string') {
    node[last] = value
    return true
  }
  return false
}

/** 环境变量前缀。 */
const ENV_PREFIX = 'DSH_CLASH_GUARD_'

/**
 * 应用环境变量覆盖。
 * @param {object} config 已合并的配置（会被就地修改）
 * @param {NodeJS.ProcessEnv} env
 * @returns {string[]} 生效的环境变量名
 */
export function applyEnv(config, env) {
  const applied = []
  for (const name of Object.keys(env)) {
    if (!name.startsWith(ENV_PREFIX)) continue
    const keys = envPath(name, ENV_PREFIX)
    if (keys.length === 0 || keys[0] === '') continue
    if (setAtPath(config, keys, String(env[name] ?? ''))) applied.push(name)
  }
  return applied
}

/**
 * 装配配置。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{config: object, defaults: object, sources: string[]}}
 */
export function loadConfig(env = process.env) {
  const defaults = readDefaults()
  const sources = ['defaults.json']
  let user = {}
  const file = settingsFile()
  try {
    user = JSON.parse(fs.readFileSync(file, 'utf8'))
    sources.push(path.basename(file))
  } catch {
    // 首次运行没有用户配置，完全正常
  }
  const merged = mergeShaped(defaults, user)
  const envApplied = applyEnv(merged, env)
  if (envApplied.length > 0) sources.push(`env(${envApplied.length})`)
  return { config: merged, defaults, sources }
}

/**
 * 求出 patch 相对 defaults 的**真实差异**（递归，只保留改过的叶子）。
 *
 * 为什么要这一步：直接把 merge 后的整份配置写进用户文件会带来两个问题 ——
 *   1. 文件臃肿（把 8KB 的 defaults 全抄一遍）；
 *   2. **defaults 升级失效**：旧值被写进用户文件后，新版默认值永远覆盖不上来。
 *
 * 所以只落差异。空对象返回 undefined 表示「这层没改」。
 *
 * @param {unknown} template
 * @param {unknown} patch
 * @returns {unknown|undefined}
 */
export function diffAgainst(template, patch) {
  if (isPlainObject(template) && isPlainObject(patch)) {
    const out = {}
    let touched = false
    for (const key of Object.keys(patch)) {
      if (!Object.hasOwn(template, key)) continue
      // 注释键是给读 defaults 的人看的，不落用户文件
      if (key.startsWith('_')) continue
      const sub = diffAgainst(template[key], patch[key])
      if (sub !== undefined) {
        out[key] = sub
        touched = true
      }
    }
    return touched ? out : undefined
  }
  if (Array.isArray(template) && Array.isArray(patch)) {
    return JSON.stringify(template) === JSON.stringify(patch) ? undefined : patch.slice()
  }
  if (patch === template) return undefined
  if (patch === undefined) return undefined
  return patch
}

/**
 * 保存用户配置：**只写与 defaults 不同的键**，保持文件可读且可升级。
 *
 * @param {object} patch 用户提交的片段
 * @param {object} defaults defaults.json
 * @returns {object} 保存后的完整配置
 */
export function saveConfig(patch, defaults) {
  const dir = ensureDir(stateDir())
  const file = path.join(dir, path.basename(settingsFile()))
  const merged = mergeShaped(defaults, patch)
  const diff = diffAgainst(defaults, merged)
  // 差异为空就写一个空对象 —— 比留一份全量副本好，也明确表达「全是默认值」
  fs.writeFileSync(file, `${JSON.stringify(diff ?? {}, null, 2)}\n`, 'utf8')
  return merged
}

/** 只读当前生效配置（给工具与路由用）。 */
export function currentConfig() {
  return loadConfig().config
}

export { ENV_PREFIX }
