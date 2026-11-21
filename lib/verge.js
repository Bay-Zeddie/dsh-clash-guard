/**
 * Clash Verge 应用数据层。
 *
 * 运行中的内核用管道 PATCH 立刻生效；但应用重启后会按配置文件的顶层
 * `mode:` 重建运行配置，所以切模式必须同时落盘，否则重启即回退。
 *
 * 写入只改 `mode:` 那一行：Clash Verge 的配置有几千行规则，整份重写会
 * 引入格式漂移。先写同目录临时文件再 rename，避免半个文件。
 *
 * ## 与 GUI 的关系（重要）
 *
 * Clash Verge GUI 的 mode 存在**内存 draft** 里（`clash.edit_draft()` →
 * `clash.apply()`），落盘时才写文件。插件从外部改磁盘文件，**不会更新
 * GUI 的内存状态** —— 所以两者会短暂不同步。
 *
 * 但这不会造成「两边同时开全局」那种冲突：内核只有一个 mode，
 * 两边改的是同一个值。真正的问题是**静默回退**：
 *
 *   插件切到 global → GUI 界面还显示 rule → 用户在 GUI 点「保存」
 *   → GUI 用内存里的 rule 写盘 → 磁盘变 rule
 *   → 内核仍是 global（GUI 不因此重启内核）
 *   → 下次内核重启，按磁盘的 rule 启动 → **静默回退**
 *
 * 本模块提供 `readInstanceRecord()` 让上层能检测到 GUI 正在运行，
 * 从而给出提示；配合 `readStoredMode` 做三方一致性校验
 * （磁盘 / 内核 / 期望），一旦发现被 GUI 覆盖就报出来。
 *
 * @module dsh-clash-guard/verge
 */
import fs from 'node:fs'
import path from 'node:path'
import { topScalar } from './discover.js'

/**
 * 把配置里顶层的 mode 改成给定值。
 * @param {object} options
 * @param {string} options.file 目标配置文件
 * @param {string} options.mode 新的 mode 值
 * @param {string} options.modeKey YAML 键名（来自 defaults.verge.modeKey）
 * @param {string} options.backupSuffix
 * @param {string} options.tempSuffix
 * @returns {{ok: boolean, file: string, previous: string, error?: string}}
 */
export function writeMode(options) {
  const { file, mode, modeKey, backupSuffix, tempSuffix } = options
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (error) {
    return { ok: false, file, previous: '', error: `cannot read: ${error.message}` }
  }

  // **保留原文件的换行风格**：Clash Verge 写的是 CRLF，整份改成 LF 会让它的
  // 后续 diff 全变，而且备份/回滚时两份文件的换行不一致。
  const usesCrlf = raw.includes('\r\n')
  const text = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const previous = topScalar(text, modeKey)
  if (previous === mode) return { ok: true, file, previous }

  const escapedKey = modeKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const line = `${modeKey}: ${mode}`
  let next
  if (new RegExp(`^${escapedKey}\\s*:.*$`, 'm').test(text)) {
    next = text.replace(new RegExp(`^${escapedKey}\\s*:.*$`, 'm'), line)
  } else {
    const firstKey = /^[A-Za-z0-9_-]+\s*:/m.exec(text)
    next = firstKey === null
      ? `${line}\n${text}`
      : `${text.slice(0, firstKey.index)}${line}\n${text.slice(firstKey.index)}`
  }

  const finalText = usesCrlf ? next.replace(/\n/g, '\r\n') : next
  const temp = `${file}${tempSuffix}`
  try {
    fs.writeFileSync(`${file}${backupSuffix}`, raw, 'utf8')
    fs.writeFileSync(temp, finalText, 'utf8')
    fs.renameSync(temp, file)
    return { ok: true, file, previous }
  } catch (error) {
    try { fs.rmSync(temp, { force: true }) } catch { /* nothing to clean */ }
    return { ok: false, file, previous, error: error.message }
  }
}

/**
 * 读 Clash Verge GUI 的单实例记录（端口 + token）。
 *
 * 文件存在**不代表 GUI 在跑** —— 它是启动时写的，退出时不一定删。
 * 所以还要看那个端口是否真的有人监听。
 *
 * @param {string[]} appDirs Verge 应用数据目录候选
 * @param {string} fileName 单实例记录文件名
 * @returns {{running: boolean, port: number, token: string, reason: string}}
 */
export function readInstanceRecord(appDirs, fileName) {
  const empty = { running: false, port: 0, token: '', reason: 'no-record' }
  if (!Array.isArray(appDirs) || appDirs.length === 0) return empty
  for (const dir of appDirs) {
    const recordPath = path.join(dir, fileName)
    let record
    try {
      record = JSON.parse(fs.readFileSync(recordPath, 'utf8'))
    } catch {
      continue
    }
    const port = Number(record?.port ?? 0)
    if (!Number.isFinite(port) || port <= 0) continue
    return {
      running: true,
      port,
      token: String(record?.token ?? ''),
      reason: 'record-found',
      file: recordPath,
    }
  }
  return empty
}



export { path }
