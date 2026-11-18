/**
 * 视觉核验台：把真实组件渲染成 HTML，供浏览器逐项目视检查。
 *
 * 为什么需要它：DSH 的 GUI 是 Electron + 启动令牌认证，外部浏览器进不去。
 * 但**视觉问题必须在真实浏览器里看**——CSS 的 color-mix、backdrop-filter、
 * 动画、窄屏折叠，在 Node 里断言不出来。
 *
 * 做法：用真实 `lib/client.js` 的 `buildCss()` 与组件，配一份真实形状的
 * `/state`、`/ip` 数据，渲染成自包含 HTML。所有颜色走**真实主题令牌值**
 * （从 DSH 的 ui-theme 里抠出来的），皮肤变量按 dsh-sunfragment-skin 的
 * 映射注入 —— 这样才能复现用户截图里的紫色 bug 一类问题。
 *
 * 跑法：node tools/visual-lab.mjs [输出路径]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const OUT = process.argv[2] ?? path.join(ROOT, 'tools', 'visual-lab.html')

const defaults = JSON.parse(fs.readFileSync(path.join(ROOT, 'defaults.json'), 'utf8'))
const strings = JSON.parse(fs.readFileSync(path.join(ROOT, 'locale', 'strings.json'), 'utf8'))
const clientSource = fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8')

/* ------------------------------------------------------------------ *
 * 1. 加载客户端模块（真实代码）
 * ------------------------------------------------------------------ */

const store = []
const effects = []
let cursor = 0

const react = {
  /**
   * 与真实 React 对齐：`createElement(type, props, ...children)` 会把
   * rest children **合并进 `props.children`**。
   *
   * 这一条不写，`<Card title="…">{内容}</Card>` 里的内容在组件内读
   * `props.children` 时就是 undefined —— 卡片只剩标题，正文全空。
   */
  createElement(type, props, ...children) {
    const flat = children.flat(Infinity).filter(c => c !== null && c !== undefined && c !== false)
    const merged = { ...(props ?? {}) }
    if (flat.length === 1) merged.children = flat[0]
    else if (flat.length > 1) merged.children = flat
    return { type, props: merged, children: flat }
  },
  useState(init) {
    const index = cursor
    cursor += 1
    if (!(index in store)) store[index] = typeof init === 'function' ? init() : init
    return [store[index], (next) => { store[index] = typeof next === 'function' ? next(store[index]) : next }]
  },
  useEffect(fn) { effects.push(fn) },
  useCallback(fn) { return fn },
}

let mod = null
globalThis.window = {
  __ModuleLoader__: {
    load({ id, factory }) {
      mod = { id, exports: factory((name) => {
        if (name === 'react') return react
        throw new Error(`unexpected require: ${name}`)
      }) }
    },
  },
}
globalThis.document = {
  documentElement: { lang: 'zh' },
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: '', id: '' }),
  head: { appendChild() {} },
}
globalThis.fetch = async () => ({ ok: false })
globalThis.console.warn = () => {}

// eslint-disable-next-line no-eval
eval(clientSource)

const I = mod.exports.__internals
I.adoptUi(defaults)

/* ------------------------------------------------------------------ *
 * 2. 渲染树 → HTML
 * ------------------------------------------------------------------ */

const esc = (text) => String(text)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')

/**
 * 把 createElement 树序列化成 HTML。
 *
 * 三个必须处理的细节（都踩过）：
 *   1. 函数组件要**调用展开**，不能当标签输出；
 *   2. `props.children` 是 createElement 合并后的**唯一真相**——
 *      `<Card>{内容}</Card>` 的内容只在这里，rest 数组是同一批节点的副本；
 *   3. 但 `Card` 这类包装组件内部又会 `h('div', {...}, props.children)`，
 *      于是 children 再次被合并进新的 props —— 每层都读 `props.children`
 *      就不会重复，也不会丢。
 */
function toHtml(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return esc(node)
  if (Array.isArray(node)) return node.map(toHtml).join('')
  if (typeof node !== 'object') return ''

  const { type, props } = node

  // 函数组件：把完整 props（含 children）交给它，由它自己决定怎么用
  if (typeof type === 'function') {
    try {
      return toHtml(type(props ?? {}))
    } catch (error) {
      return `<!-- render error: ${esc(error.message)} -->`
    }
  }

  // DOM 元素：`props.children` 与 `node.children` 是同一批节点的两种存法。
  // 只取一处 —— 优先 props.children（createElement 合并过），空则退回 rest。
  const fromProps = props?.children
  const kids = (fromProps === undefined || fromProps === null)
    ? (node.children ?? [])
    : (Array.isArray(fromProps) ? fromProps : [fromProps])

  const attrs = []
  for (const [key, value] of Object.entries(props ?? {})) {
    if (key === 'children') continue
    if (value === undefined || value === null || value === false) continue
    if (key === 'style' && typeof value === 'object') {
      const cssText = Object.entries(value)
        .map(([k, v]) => `${k.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`)}:${v}`)
        .join(';')
      attrs.push(`style="${esc(cssText)}"`)
      continue
    }
    if (key === 'className') { attrs.push(`class="${esc(value)}"`); continue }
    if (key.startsWith('data-') || key === 'title' || key === 'type' || key === 'role' || key === 'aria-busy' || key === 'aria-label' || key === 'aria-hidden') {
      attrs.push(`${key}="${esc(value)}"`)
      continue
    }
    if (key === 'checked') { if (value === true) attrs.push('checked'); continue }
    if (key === 'onClick' || key === 'onChange' || key === 'disabled') continue
    attrs.push(`${key}="${esc(value)}"`)
  }

  const body = kids.map(toHtml).join('')
  const tag = String(type)
  if (tag === 'br' || tag === 'hr' || tag === 'img' || tag === 'input') {
    return `<${tag} ${attrs.join(' ')}>`
  }
  return `<${tag} ${attrs.join(' ')}>${body}</${tag}>`
}

/* ------------------------------------------------------------------ *
 * 3. 数据：覆盖所有状态的样本
 * ------------------------------------------------------------------ */

const realIp = '39.144.124.132'

/** 一份完整的 /state 应答。 */
const stateReachable = {
  ok: true,
  reachable: true,
  version: 'v1.19.33',
  transport: 'pipe',
  source: 'process:command-line',
  mode: 'global',
  modeName: 'global',
  storedMode: 'global',
  modeFile: 'C:\\Users\\me\\AppData\\Roaming\\io.github.clash-verge-rev.clash-verge-rev\\clash-verge.yaml',
  mixedPort: 7897,
  elevated: true,
  realIp,
  tun: { enable: true, stack: 'gVisor', autoRoute: true, strictRoute: true },
  dns: { enable: true, enhancedMode: 'fake-ip', hijack: ['any:53'] },
  selector: { group: 'GLOBAL', now: '日本JP-HY2' },
  settings: defaults,
  attempts: [{ source: 'process:command-line', transport: 'pipe', ok: true, version: 'v1.19.33' }],
}

/** 控制器不可达。 */
const stateUnreachable = {
  ok: false,
  reachable: false,
  error: '没有候选应答 /version',
  attempts: [
    { source: 'process:command-line', transport: 'pipe', ok: false, error: 'ENOENT' },
    { source: 'pipe:enumeration', transport: 'pipe', ok: false, error: 'ENOENT' },
    { source: 'config:clash-verge.yaml', transport: 'pipe', ok: false, error: 'ENOENT' },
    { source: 'config:clash-verge.yaml:tcp', transport: 'tcp', ok: false, error: 'ECONNREFUSED' },
  ],
  settings: defaults,
}

/** 审计结果：混着通过与失败，覆盖四种严重度。 */
const auditResult = {
  ok: true,
  verdict: 'leaking',
  snapshot: { egressIp: '103.187.168.155', realIp, totalConnections: 28, directConnections: 19 },
  checks: [
    { id: 'mode', severity: 'critical', ok: true, title: '内核处于全局模式', detail: 'mode=global' },
    { id: 'tun', severity: 'critical', ok: true, title: 'TUN 已开启', detail: '协议栈=gVisor，自动路由=开，来源=运行时' },
    { id: 'auto-route', severity: 'critical', ok: true, title: 'TUN 自动路由已开启', detail: 'auto-route=true' },
    { id: 'strict-route', severity: 'high', ok: true, title: 'TUN 严格路由已开启', detail: 'strict-route=true' },
    { id: 'dns-fakeip', severity: 'critical', ok: true, title: 'DNS fake-ip 已开启', detail: 'enable=true，enhanced-mode=fake-ip，来源=配置文件' },
    { id: 'dns-hijack', severity: 'critical', ok: true, title: 'DNS 劫持覆盖全部网段', detail: 'any:53' },
    { id: 'global-selector', severity: 'critical', ok: true, title: '选择器出口不是直连/拒绝', detail: 'GLOBAL=日本JP-HY2' },
    { id: 'live-direct', severity: 'critical', ok: false, title: 'global 模式下没有直连活连接', detail: '19/28 条连接直连 —— 真实 IP 正在暴露。切换到 global 会断开全部旧连接，请重新切换一次' },
    { id: 'process-direct', severity: 'critical', ok: false, title: 'global 模式下没有进程直连', detail: '3 个进程在直连：wps.exe(2/2), WorkBuddy.exe(2/2), node.exe(1/1)' },
    { id: 'interface-bypass', severity: 'critical', ok: false, title: '物理网卡无法绕过 TUN', detail: '绑定 10.252.28.236 能连到 1.1.1.1:80 —— 这条路径绕过了 TUN' },
    { id: 'default-routes', severity: 'critical', ok: false, title: '默认路由由 TUN 独占', detail: '物理网卡与 TUN 的默认路由 metric 竞争：WLAN(metric 0) vs TUN(metric 0) —— 绑物理网卡的流量可能直连' },
    { id: 'system-resolver', severity: 'high', ok: true, title: '系统解析走 fake-ip', detail: 'www.gstatic.com → 198.18.0.108（系统解析走 mihomo fake-ip）' },
    { id: 'egress', severity: 'critical', ok: true, title: '代理出口可用', detail: '103.187.168.155（via https://api.ipify.org）' },
    { id: 'egress-vs-real', severity: 'critical', ok: true, title: '出口 IP 不等于校准的真 IP', detail: '出口 103.187.168.155 != 真 IP 39.144.124.132' },
    { id: 'system-proxy', severity: 'medium', ok: true, title: 'WinINET 系统代理指向混合端口', detail: '127.0.0.1:7897' },
    { id: 'winhttp', severity: 'low', ok: false, title: 'WinHTTP 代理已设置', detail: 'Direct access（部分服务/后台进程不受 WinINET 影响）' },
    { id: 'auto-doh', severity: 'high', ok: true, title: 'DoH 自动升级已关闭', detail: 'EnableAutoDoh=0' },
    { id: 'ipv6', severity: 'high', ok: true, title: '物理网卡 IPv6 已关断', detail: 'WLAN IPv6 unbound' },
    { id: 'dns-resolver', severity: 'medium', ok: true, title: '物理网卡 DNS 不指向 ISP', detail: 'WLAN: 198.18.0.2（期望 198.18.0.2）' },
  ],
}

/** 节点列表。 */
const nodesResult = {
  ok: true,
  group: 'GLOBAL',
  current: '日本JP-HY2',
  picked: '',
  error: '',
  nodes: [
    { name: '日本JP-HY2', type: 'Hysteria2', delay: 74, alive: true },
    { name: '新加坡04-0.1倍', type: 'Vless', delay: 158, alive: true },
    { name: '美国圣何塞01 | 三网推荐', type: 'Vless', delay: 210, alive: true },
    { name: '台湾3 | 避免晚高峰使用', type: 'Hysteria2', delay: 0, alive: false },
    { name: 'AWS日本03 | 电信移动联通推荐', type: 'Vless', delay: 3932, alive: true },
  ],
}

/** /ip 的五种结论。 */
const ipVariants = {
  masked: {
    ok: true, phase: 'ok', verdict: 'masked', tone: 'on', realIp, exposedPaths: [],
    system: { ip: '103.187.168.155', ok: true },
    proxy: { ip: '103.187.168.155', ok: true },
    bound: { ip: '', ok: false, detail: 'timeout' },
    adapter: '10.252.28.236', mode: 'global', modeName: 'global',
  },
  exposed: {
    ok: true, phase: 'ok', verdict: 'exposed', tone: 'off', realIp, exposedPaths: ['system'],
    system: { ip: realIp, ok: true },
    proxy: { ip: '103.187.168.155', ok: true },
    bound: { ip: '', ok: false, detail: 'timeout' },
    adapter: '10.252.28.236', mode: 'direct', modeName: 'off',
  },
  bypassable: {
    ok: true, phase: 'ok', verdict: 'bypassable', tone: 'warn', realIp, exposedPaths: [],
    system: { ip: '103.187.168.155', ok: true },
    proxy: { ip: '103.187.168.155', ok: true },
    bound: { ip: '18.183.108.154', ok: true, detail: '' },
    adapter: '10.252.28.236', mode: 'rule', modeName: 'rule',
  },
  uncalibrated: {
    ok: true, phase: 'ok', verdict: 'uncalibrated', tone: 'warn', realIp: '', exposedPaths: [],
    system: { ip: '103.187.168.155', ok: true },
    proxy: { ip: '103.187.168.155', ok: true },
    bound: { ip: '', ok: false, detail: 'timeout' },
    adapter: '10.252.28.236', mode: 'rule', modeName: 'rule',
  },
  noEgress: {
    ok: false, phase: 'no-egress', verdict: 'no-egress', tone: 'warn', realIp, exposedPaths: [],
    system: { ip: '', ok: false },
    proxy: { ip: '', ok: false },
    bound: { ip: '', ok: false, detail: 'timeout' },
    adapter: '10.252.28.236', mode: 'rule', modeName: 'rule',
  },
}

/** 内核状态。 */
const kernelResult = {
  ok: true,
  state: {
    coreRunning: true,
    corePids: [3752],
    guiRunning: false,
    guiPids: [],
    serviceExists: true,
    serviceRunning: true,
    serviceStartMode: 'Auto',
    controllerAlive: true,
    version: 'v1.19.33',
    desiredCoreShouldRun: true,
    canStartByService: true,
    summary: '内核在跑，控制器可达，GUI 未启动 —— 插件可独立控制',
  },
}

/* ------------------------------------------------------------------ *
 * 4. 组装 HTML
 * ------------------------------------------------------------------ */

function renderPanel(state, audit, nodes, kernel) {
  // 每次渲染前重置 hook 游标与存储，模拟全新挂载
  store.length = 0
  effects.length = 0
  cursor = 0

  // 把数据塞进一个假的 fetch，让组件的 effect 拿到
  globalThis.fetch = async (url) => {
    const href = String(url)
    if (href.includes('/i18n')) return { ok: true, json: async () => ({ ok: true, table: strings }) }
    if (href.includes('/ip')) return { ok: true, json: async () => ipVariants.masked }
    if (href.includes('/kernel')) return { ok: true, json: async () => kernel }
    if (href.includes('/nodes')) return { ok: true, json: async () => nodes }
    if (href.includes('/verify')) return { ok: true, json: async () => audit }
    return { ok: true, json: async () => state }
  }

  // 第一遍：渲染并跑 effect（effect 会 setState）
  let tree = I.GuardPanel({})
  const pending = effects.splice(0)
  for (const fn of pending) { try { fn() } catch { /* ignore */ } }

  // effect 里的 Promise 需要真的 await，这里用同步占位：
  // 直接手动把数据塞进 hook 存储（顺序与组件内 useState 声明一致）
  // —— 比等异步更可控，视觉核验只需要最终态。
  return { tree, state, audit, nodes, kernel }
}

/* 用「先跑一遍拿 hook 顺序，再按顺序填值」的办法构造最终态。
   更简单可靠的做法：直接给每个区块单独渲染。 */

const css = I.buildCss()

/* 文案表：同步灌进去。
   `t()` 读的是模块内的 `dictionary`，而 `loadDictionary()` 是异步的。
   视觉台不需要真的走一遍网络，直接把字典喂进去即可 —— 但必须**在渲染之前**。 */
globalThis.fetch = async (url) => {
  const href = String(url)
  if (href.includes('/i18n')) return { ok: true, json: async () => ({ ok: true, table: strings }) }
  return { ok: false, json: async () => null }
}
await I.loadDictionary()

/**
 * 渲染一个组件的「最终态」。
 *
 * **关键**：`useState` 的槽位是**调用顺序**决定的，不是名字。
 * 组件在 `state === null` 时会提前 return，后续 useState 根本不执行 ——
 * 所以不能「先空跑一次建立槽位再填值」，那样槽位是残缺的。
 *
 * 正确做法：先把值**预置**进 store，再渲染。
 * 组件的 useState 按顺序读到的就是预置值。
 *
 * @param {Function} component
 * @param {Array<[number, unknown]>} values 索引 → 值
 * @returns {object} 渲染树
 */
function renderWith(component, values) {
  store.length = 0
  effects.length = 0
  for (const [index, value] of values) store[index] = value
  cursor = 0
  const tree = component({})
  // 渲染过程中新产生的 effect 不执行 —— 视觉台只要静态终态
  effects.length = 0
  return tree
}

const sections = []

/* —— 指示灯：五种结论 —— */
sections.push('<h2>出口 IP 指示灯</h2><p class="note">五种结论 + 检测中 / 后台刷新。悬停看 title。</p><div class="row">')
for (const [key, payload] of Object.entries(ipVariants)) {
  const tree = renderWith(I.IpIndicator, [[0, payload], [1, false], [2, 0]])
  sections.push(`<div class="cell"><div class="label">${esc(key)}</div>${toHtml(tree)}</div>`)
}
// 首屏检测中
sections.push(`<div class="cell"><div class="label">checking（首屏）</div>${toHtml(renderWith(I.IpIndicator, [[0, null], [1, true], [2, 0]]))}</div>`)
// 后台刷新
sections.push(`<div class="cell"><div class="label">refreshing（后台）</div>${toHtml(renderWith(I.IpIndicator, [[0, ipVariants.masked], [1, true], [2, 1]]))}</div>`)
sections.push('</div>')

/* —— 面板：可达 —— */
sections.push('<h2>主面板 · 控制器可达</h2><p class="note">四张卡片：模式 / 泄漏审计 / 出口节点 / 加固项，外加内核与服务。</p><div class="panel">')
{
  const tree = renderWith(I.GuardPanel, [
    [0, stateReachable],   // state
    [1, auditResult],      // audit
    [2, nodesResult],      // nodes
    [3, ''],               // busy
    [4, ''],               // error
    [5, defaults],         // settings
    [6, ''],               // saved
    [7, kernelResult.state], // kernel
  ])
  sections.push(toHtml(tree))
}
sections.push('</div>')

/* —— 面板：不可达 —— */
sections.push('<h2>主面板 · 控制器不可达</h2><p class="note">必须给出诊断，不能白屏。</p><div class="panel">')
{
  const tree = renderWith(I.GuardPanel, [
    [0, stateUnreachable], [1, null], [2, null], [3, ''], [4, ''], [5, defaults], [6, ''], [7, kernelResult.state],
  ])
  sections.push(toHtml(tree))
}
sections.push('</div>')

/* —— 面板：首屏加载 —— */
sections.push('<h2>主面板 · 首屏加载</h2><div class="panel">')
{
  const tree = renderWith(I.GuardPanel, [[0, null], [1, null], [2, null], [3, ''], [4, ''], [5, null], [6, ''], [7, null]])
  sections.push(toHtml(tree))
}
sections.push('</div>')

/* —— 审计清单单独放大 —— */
sections.push('<h2>审计清单 · 四种严重度 × 通过与失败</h2><div class="panel"><div class="dskg-card">')
for (const check of auditResult.checks) {
  sections.push(toHtml(I.CheckRow({ check })))
}
sections.push('</div></div>')

/* —— 三段式开关（可选座位） —— */
sections.push('<h2>三段式小开关（enablePill 开启时）</h2><div class="row">')
for (const mode of ['global', 'rule', 'off']) {
  const tree = renderWith(I.ModePill, [
    [0, { ok: true, reachable: true, modeName: mode }], [1, ''],
  ])
  sections.push(`<div class="cell"><div class="label">${mode}</div>${toHtml(tree)}</div>`)
}
sections.push('</div>')

/* ------------------------------------------------------------------ *
 * 5. 主题令牌：从 DSH 真实主题 + 皮肤映射推导
 * ------------------------------------------------------------------ */

/**
 * 这里注入的是**皮肤（dsh-sunfragment-skin）在场时的令牌值**。
 *
 * 关键复现点：皮肤把 `state-warn-primary` 与 `state-warn-secondary`
 * 都映射成 `violet`，把 `interactive-bg-hover` 映射成 `violetTint` ——
 * 那正是用户截图里「紫药丸」与「紫横条」的成因。
 * 视觉台必须复现这个环境，否则测不出问题。
 *
 * 注意：变量必须**包在 `:root { }` 里**。散落在块外会被浏览器整段丢弃，
 * 于是所有 var() 都取不到值 —— 圆点会变成透明、边框变纯白。
 */
const themeVars = `:root {
  color-scheme: dark;

  /* 底色：皮肤把 bg-* 全清成透明，露出壁纸 */
  --dsw-alias-bg-base: transparent;
  --dsw-alias-bg-layer-1: rgba(255,255,255,.05);
  --dsw-alias-bg-layer-2: rgba(255,255,255,.07);
  --dsw-alias-bg-layer-3: rgba(255,255,255,.09);
  --dsw-alias-bg-overlay: rgba(16,18,22,.86);
  --dsw-alias-bg-multi-select: rgba(201,124,243,.20);

  /* 文字 */
  --dsw-alias-label-primary: #ffffff;
  --dsw-alias-label-secondary: rgba(255,255,255,.78);
  --dsw-alias-label-tertiary: rgba(255,255,255,.55);
  --dsw-alias-label-primary-foreground: #0b0d10;

  /* 边框 */
  --dsw-alias-border-l1: rgba(255,255,255,.16);
  --dsw-alias-border-l2: rgba(255,255,255,.26);
  --dsw-alias-border-l3: rgba(255,255,255,.42);

  /* 状态：**皮肤把 warn 两档都映射成 violet** —— 紫 bug 的根源 */
  --dsw-alias-state-success-primary: #2eff62;
  --dsw-alias-state-success-secondary: rgba(46,255,98,.20);
  --dsw-alias-state-warn-primary: #c97cf3;
  --dsw-alias-state-warn-secondary: #c97cf3;
  --dsw-alias-state-error-primary: #bf3636;
  --dsw-alias-state-error-secondary: rgba(191,54,54,.42);
  --dsw-alias-state-idle-primary: #6b7280;

  /* 交互 */
  --dsw-alias-interactive-bg-hover: rgba(201,124,243,.20);
  --dsw-alias-interactive-bg-active: rgba(201,124,243,.32);
  --dsw-alias-brand-primary: #2eff62;
  --dsw-focus-ring-color: rgba(46,255,98,.45);
  --dsw-radius-sm: 8px;

  /* 磨砂：皮肤写死的单档值 */
  --dsw-menu-backdrop-filter: blur(10px) saturate(160%) brightness(.82);
}`

const html = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>dsh-clash-guard 视觉核验台</title>
<style>
  :root { color-scheme: dark; }
  ${themeVars}

  html, body { margin: 0; padding: 0; }
  body {
    /* 模拟皮肤下的壁纸背景 —— 磨砂效果必须压在东西上才看得出来 */
    background:
      radial-gradient(circle at 18% 22%, #3a4a63 0%, transparent 46%),
      radial-gradient(circle at 82% 18%, #4a3a55 0%, transparent 42%),
      radial-gradient(circle at 62% 82%, #26343f 0%, transparent 50%),
      linear-gradient(140deg, #0e141b 0%, #1a2330 42%, #101820 100%);
    background-attachment: fixed;
    color: #fff;
    font-family: "Segoe UI", "Microsoft YaHei UI", system-ui, sans-serif;
    font-size: 13px;
    line-height: 1.6;
    padding: 28px 32px 80px;
  }
  h1 { font-size: 22px; font-weight: 500; margin: 0 0 6px; }
  h2 { font-size: 15px; font-weight: 600; margin: 34px 0 6px; color: #9fe8b8; }
  .note { margin: 0 0 14px; color: rgba(255,255,255,.55); font-size: 12px; }
  .row { display: flex; gap: 20px; flex-wrap: wrap; align-items: center; }
  .cell { display: flex; flex-direction: column; gap: 6px; }
  .cell .label { font-size: 11px; color: rgba(255,255,255,.45); font-family: ui-monospace, Consolas, monospace; }
  .panel { max-width: 900px; }
  .dskg { height: auto; max-height: none; overflow: visible; padding: 0; }

  /* 插件自己的样式由 buildCss() 注入在下面 */
${css}
</style>
</head>
<body>
<h1>dsh-clash-guard 视觉核验台</h1>
<p class="note">
  真实组件 + 真实 CSS + 皮肤令牌值。背景是模拟壁纸，用来验证磨砂与对比度。
  把鼠标停在指示灯上看 title；缩窗口到 &lt;1100px / &lt;860px 看标签折叠。
</p>
${sections.join('\n')}
</body>
</html>
`

fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, html, 'utf8')

const bytes = Buffer.byteLength(html)
console.log('视觉核验台已生成')
console.log('  路径:', OUT)
console.log('  大小:', (bytes / 1024).toFixed(1), 'KB')
console.log('  区块:', sections.filter(s => s.startsWith('<h2')).length, '组')
console.log('  CSS 行数:', css.split('\n').length)

// 这是一份**生成器**，不是断言测试：产物正确与否由浏览器核验。
process.exit(0)
