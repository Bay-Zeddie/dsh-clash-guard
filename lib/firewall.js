/**
 * 接口级出站封锁 —— 真正堵住「绑物理网卡直连」的手段。
 *
 * ## 为什么需要它（三次实测的结论）
 *
 * 目标是「除了代理，任何程序都不能从物理网卡出网」。三条路都试过：
 *
 * | 手段 | 结果 |
 * |---|---|
 * | `tun.strict-route: true` | ✘ 写进配置和文件都不生效，绑卡照样直连 |
 * | 抬高物理网卡默认路由 metric | ✘ 路由表变 `tun-wins` 了，绑卡仍直连 |
 * | 摘掉物理网卡默认网关 | ✘ 绑卡堵住了（ENETUNREACH），**但 mihomo 自己也断了** |
 *
 * 原因：Windows 在 `bind()` 到某个源地址时会**强制走该地址所属接口，无视路由表**。
 * 而 mihomo 连节点又必须从物理网卡出去 —— 所以不能靠路由表区分「谁在用」。
 *
 * 唯一能区分「谁在用」的层是**防火墙**（WFP，在路由之上，按进程匹配）：
 *
 *   1. `Block` 出站、限定 `InterfaceAlias = 物理网卡`   → 谁都不许从这块网卡直接出去
 *   2. `Allow` 出站、限定 `Program = mihomo 可执行`      → 只放行代理内核
 *
 * Windows 防火墙的匹配顺序里 Allow 优先于 Block（同一层规则），所以第 2 条
 * 让 mihomo 能连节点，第 1 条挡住其它所有程序。普通程序的流量走 TUN
 * （`Meta` 接口，不在封锁范围内），照常工作。
 *
 * ## 安全边界
 *
 * 这是**会断网的操作**，所以：
 *   · 规则带固定前缀，撤销时按前缀精确删除，绝不碰用户自己的规则；
 *   · 失败时立刻清理自己刚建的规则；
 *   · 调用方必须在同一个流程里做「应用 → 验证 → 失败即撤销」。
 *
 * @module dsh-clash-guard/firewall
 */
import { shell } from './windows.js'

/**
 * 建规则。
 *
 * @param {object} options
 * @param {object} options.cfg defaults.windows
 * @param {object} options.rules defaults.firewall
 * @param {string} options.alias 物理网卡名
 * @param {string} options.corePath mihomo 可执行路径
 * @returns {Promise<{ok: boolean, created: string[], detail: string}>}
 */
export async function applyInterfaceBlock(options) {
  const { cfg, rules, alias, corePath } = options

  if (typeof alias !== 'string' || alias === '') {
    return { ok: false, created: [], detail: '没有物理网卡名' }
  }
  if (typeof corePath !== 'string' || corePath === '') {
    return { ok: false, created: [], detail: '不知道内核可执行路径，无法放行' }
  }

  const blockName = `${rules.rulePrefix}${rules.blockSuffix}`
  const allowName = `${rules.rulePrefix}${rules.allowSuffix}`

  // 先清掉可能残留的同名规则，保证幂等
  //
  // 注意：PowerShell 里用反引号续行在 JS 模板字符串里会出问题（反引号是模板分隔符），
  // 所以这里每条 cmdlet 都写成单行，不做续行。
  const safeCore = corePath.replace(/'/g, "''")
  const safeAlias = alias.replace(/'/g, "''")

  const script = [
    "$ErrorActionPreference = 'Stop'",
    `Remove-NetFirewallRule -DisplayName '${blockName}' -ErrorAction SilentlyContinue`,
    `Remove-NetFirewallRule -DisplayName '${allowName}' -ErrorAction SilentlyContinue`,
    // 1. 放行代理内核（Allow 优先于 Block）
    `New-NetFirewallRule -DisplayName '${allowName}' -Direction Outbound -Action Allow -Program '${safeCore}' -Profile Any -ErrorAction Stop | Out-Null`,
    // 2. 阻止该网卡上的其余出站
    `New-NetFirewallRule -DisplayName '${blockName}' -Direction Outbound -Action Block -InterfaceAlias '${safeAlias}' -Profile Any -ErrorAction Stop | Out-Null`,
    "Write-Output 'ok'",
  ].join('\n')

  const result = await shell(cfg, script)
  const out = String(result?.stdout ?? '')
  if (!result.ok || !out.includes('ok')) {
    // 失败就把可能建了一半的规则清掉
    await removeInterfaceBlock({ cfg, rules }).catch(() => {})
    return {
      ok: false,
      created: [],
      detail: (result?.stderr || out || 'needs elevation').slice(0, 300),
    }
  }

  return {
    ok: true,
    created: [allowName, blockName],
    detail: `已封锁 ${alias} 出站，仅放行 ${corePath.split(/[\\/]/).pop()}`,
  }
}

/**
 * 删规则（按固定前缀精确匹配，不碰用户规则）。
 *
 * @param {object} options
 * @param {object} options.cfg defaults.windows
 * @param {object} options.rules defaults.firewall
 * @returns {Promise<{ok: boolean, removed: number, detail: string}>}
 */
export async function removeInterfaceBlock(options) {
  const { cfg, rules } = options
  const blockName = `${rules.rulePrefix}${rules.blockSuffix}`
  const allowName = `${rules.rulePrefix}${rules.allowSuffix}`

  const script = `
$ErrorActionPreference = 'Stop'
$names = @('${blockName}', '${allowName}')
$removed = 0
foreach ($n in $names) {
  $found = Get-NetFirewallRule -DisplayName $n -ErrorAction SilentlyContinue
  if ($found) { Remove-NetFirewallRule -DisplayName $n -ErrorAction SilentlyContinue; $removed++ }
}
Write-Output ('ok:' + $removed)
`
  const result = await shell(cfg, script)
  const out = String(result?.stdout ?? '')
  if (!result.ok || !out.includes('ok:')) {
    return { ok: false, removed: 0, detail: (result?.stderr || out || 'needs elevation').slice(0, 200) }
  }
  const removed = Number(out.split('ok:')[1]) || 0
  return { ok: true, removed, detail: removed === 0 ? '没有需要删除的规则' : `已删除 ${removed} 条规则` }
}

/**
 * 查规则当前是否生效。
 *
 * @param {object} options
 * @param {object} options.cfg defaults.windows
 * @param {object} options.rules defaults.firewall
 * @returns {Promise<{active: boolean, rules: Array<object>}>}
 */
export function inspectInterfaceBlock(options) {
  const { cfg, rules } = options
  const prefix = rules.rulePrefix
  const script = `
Get-NetFirewallRule -DisplayName '${prefix}*' -ErrorAction SilentlyContinue |
  ForEach-Object { '{0}|{1}|{2}|{3}' -f $_.DisplayName, $_.Direction, $_.Action, $_.Enabled }
`
  return shell(cfg, script).then((result) => {
    const out = String(result?.stdout ?? '')
    const rows = out
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [name, direction, action, enabled] = line.split('|')
        return { name, direction, action, enabled: String(enabled).toLowerCase() === 'true' }
      })
    return { active: rows.length > 0, rules: rows }
  })
}

/**
 * 找 mihomo 可执行路径（用于放行规则）。
 *
 * 来源优先级：服务 desired-state 里记的 `core_path` → 进程命令行。
 *
 * @param {object} options
 * @param {object} options.discovered discover() 的返回值
 * @returns {string}
 */
export function resolveCorePath(options) {
  const { discovered } = options
  const control = discovered?.serviceControl
  if (control !== null && control !== undefined && typeof control.corePath === 'string' && control.corePath !== '') {
    return control.corePath
  }
  // 退路：从进程命令行抠
  const commands = Array.isArray(discovered?.coreCommandLines) ? discovered.coreCommandLines : []
  for (const command of commands) {
    const match = /(?:"([^"]+\.exe)"|(\S+\.exe))/i.exec(command)
    if (match !== null) return match[1] ?? match[2] ?? ''
  }
  return ''
}
