/**
 * Clash Verge 应用数据层。
 *
 * 运行中的内核用管道 PATCH 立刻生效；但应用重启后会按配置文件的顶层
 * `mode:` 重建运行配置，所以切模式必须同时落盘，否则重启即回退。
 *
 * 写入只改 `mode:` 那一行：Clash Verge 的配置有几千行规则，整份重写会
 * 引入格式漂移。先写同目录临时文件再 rename，避免半个文件。
 *
 * @module dsh-clash-guard/verge
 */
import fs from 'node:fs'
import path from 'node:path'
import { topScalar } from './discover.js'

/**
 * 读某份配置里持久化的 mode。
 * @param {string} file
 * @param {string} modeKey
 * @returns {string}
 */
export function readMode(file, modeKey) {
  try {
    // 规范化 CRLF：`topScalar` 的 `$` 前残留的 `\r` 会让读到的值带回车
    const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    return topScalar(text, modeKey)
  } catch {
    return ''
  }
}

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

/** 备份文件路径。 */
export function backupFile(file, backupSuffix) {
  return `${file}${backupSuffix}`
}

/** 从备份恢复。 */
export function restoreBackup(file, backupSuffix) {
  const backup = backupFile(file, backupSuffix)
  try {
    const text = fs.readFileSync(backup, 'utf8')
    fs.writeFileSync(file, text, 'utf8')
    return { ok: true, file }
  } catch (error) {
    return { ok: false, file, error: error.message }
  }
}

export { path }
