/**
 * 路径推导 —— 零硬编码的唯一来源。
 *
 * 本模块回答一个问题：**这台机器上的 Clash Verge 把东西放在哪**。
 * 答案全部来自环境变量与标准目录约定，代码里不出现任何绝对路径、
 * 不出现任何厂商目录名字面量（那些名字在 defaults.json 里）。
 *
 * @module dsh-clash-guard/paths
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 插件包根（`lib/` 的上一级）。junction 安装下也正确。 */
export function packageRoot() {
  return path.dirname(path.dirname(fileURLToPath(import.meta.url)))
}

/** 读包内 defaults.json。 */
export function readDefaults() {
  const file = path.join(packageRoot(), 'defaults.json')
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

/** DSH 主目录：`$DSH_HOME` → `~/.dsh`。 */
export function dshHome() {
  const fromEnv = String(process.env.DSH_HOME ?? '').trim()
  return fromEnv === '' ? path.join(os.homedir(), '.dsh') : fromEnv
}

/** 本插件在 DSH 主目录下的私有数据目录。 */
export function stateDir() {
  return path.join(dshHome(), 'dsh-clash-guard')
}

/** 设置文件。 */
export function settingsFile() {
  return path.join(stateDir(), 'settings.json')
}

/** 状态文件（真 IP、上次加固结果）。 */
export function stateFile() {
  return path.join(stateDir(), 'state.json')
}

/** Windows 的 Roaming 目录，跨平台时按 os.homedir 推导。 */
function roamingDir() {
  const fromEnv = String(process.env.APPDATA ?? '').trim()
  return fromEnv === '' ? path.join(os.homedir(), 'AppData', 'Roaming') : fromEnv
}

/** Windows 的 ProgramData 目录。 */
function programDataDir() {
  const fromEnv = String(process.env.ProgramData ?? '').trim()
  if (fromEnv !== '') return fromEnv
  const drive = String(process.env.SystemDrive ?? 'C:').replace(/\\+$/, '')
  return path.join(`${drive}\\`, 'ProgramData')
}

/**
 * 在候选父目录下按名字模式找目录。
 * @param {string[]} parents 父目录
 * @param {string[]} patterns 名字里包含的片段（小写比较）
 * @returns {string[]} 命中的绝对路径
 */
function scanDirs(parents, patterns) {
  const hits = []
  const wanted = patterns.map(p => p.toLowerCase())
  for (const parent of parents) {
    let names = []
    try {
      names = fs.readdirSync(parent, { withFileTypes: true })
        .filter(e => e.isDirectory() || e.isSymbolicLink())
        .map(e => e.name)
    } catch {
      continue
    }
    for (const name of names) {
      const lower = name.toLowerCase()
      if (!wanted.some(w => lower.includes(w))) continue
      const full = path.join(parent, name)
      if (hits.includes(full)) continue
      hits.push(full)
    }
  }
  return hits
}

/**
 * Clash Verge 的应用数据目录候选（按优先级）。
 * @param {object} discovery defaults.json 的 discovery 段
 * @returns {string[]}
 */
export function appDataCandidates(discovery) {
  const parents = [roamingDir(), path.join(os.homedir(), '.config'), os.homedir()]
  return scanDirs(parents, discovery.appDirPatterns)
}

/**
 * Clash Verge 服务目录候选。
 * @param {object} discovery
 * @returns {string[]}
 */
export function serviceDirCandidates(discovery) {
  const parents = [programDataDir(), path.join(os.homedir(), 'AppData', 'Local')]
  return scanDirs(parents, discovery.serviceDirPatterns)
}

/**
 * 服务侧内核运行目录（`users/<id>/runtime`）候选。
 * @param {string[]} serviceDirs
 * @param {object} discovery defaults.json 的 discovery 段
 * @returns {string[]}
 */
export function runtimeDirCandidates(serviceDirs, discovery) {
  const usersName = discovery.runtimeUsersDir
  const runtimeName = discovery.runtimeSubdir
  const configName = discovery.runtimeConfigName
  const hits = []
  for (const serviceDir of serviceDirs) {
    const usersDir = path.join(serviceDir, usersName)
    let ids = []
    try {
      ids = fs.readdirSync(usersDir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name)
    } catch {
      continue
    }
    for (const id of ids) {
      const runtime = path.join(usersDir, id, runtimeName)
      if (fs.existsSync(path.join(runtime, configName))) hits.push(runtime)
    }
  }
  return hits
}

/**
 * 应用侧配置文件候选（`<appData>/<configFileNames>`）。
 * @param {string[]} appDirs
 * @param {string[]} names
 * @returns {string[]}
 */
export function appConfigCandidates(appDirs, names) {
  const hits = []
  for (const dir of appDirs) {
    for (const name of names) {
      const file = path.join(dir, name)
      if (fs.existsSync(file)) hits.push(file)
    }
  }
  return hits
}

/** 确保目录存在。 */
export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}
