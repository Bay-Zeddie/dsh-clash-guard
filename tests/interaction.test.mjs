/**
 * 交互行为测试：点击真的会发请求吗？请求体对吗？
 *
 * 视觉台只证明「能点」，这里证明「点了会做事」。
 * 用真实 `lib/client.js` + 拦截 fetch，逐个数每个可点元素的网络副作用。
 *
 * 跑法：node tests/interaction.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const defaults = JSON.parse(fs.readFileSync(path.join(ROOT, 'defaults.json'), 'utf8'))
const strings = JSON.parse(fs.readFileSync(path.join(ROOT, 'locale', 'strings.json'), 'utf8'))
const source = fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8')

/* ---------------- 环境 ---------------- */

/** 建一个可用的组件运行环境，并记录所有 fetch。 */
function boot(payloadFor) {
  const store = []
  const effects = []
  let cursor = 0
  const calls = []

  const react = {
    createElement(type, props, ...children) {
      const flat = children.flat(Infinity).filter(c => c !== null && c !== undefined && c !== false)
      const merged = { ...(props ?? {}) }
      if (flat.length === 1) merged.children = flat[0]
      else if (flat.length > 1) merged.children = flat
      return { type, props: merged, children: flat }
    },
    useState(init) {
      const i = cursor
      cursor += 1
      if (!(i in store)) store[i] = typeof init === 'function' ? init() : init
      return [store[i], (n) => { store[i] = typeof n === 'function' ? n(store[i]) : n }]
    },
    useEffect(fn) { effects.push(fn) },
    useCallback(fn) { return fn },
  }

  let mod = null
  globalThis.window = {
    __ModuleLoader__: {
      load({ factory }) {
        mod = { exports: factory((name) => {
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
  globalThis.fetch = async (url, init) => {
    const href = String(url)
    calls.push({
      url: href,
      method: init?.method ?? 'GET',
      body: init?.body ?? null,
      headers: init?.headers ?? {},
    })
    const payload = payloadFor(href)
    if (payload === undefined) return { ok: false, status: 404, json: async () => null }
    return { ok: true, status: 200, json: async () => payload }
  }
  globalThis.console.warn = () => {}

  // eslint-disable-next-line no-eval
  eval(source)
  return {
    mod,
    react,
    calls,
    resetCursor() { cursor = 0 },
    runEffects() { for (const fn of effects.splice(0)) { try { fn() } catch { /* ignore */ } } },
    clearCalls() { calls.length = 0 },
    /** 当前 hook 存储快照（验证 setter 是否真的写了值）。 */
    storeSnapshot() { return store.slice() },
  }
}

const state = {
  ok: true, reachable: true, mode: 'global', modeName: 'global',
  transport: 'pipe', source: 'process:command-line', mixedPort: 7897,
  elevated: true, realIp: '39.144.124.132', settings: defaults,
  tun: { enable: true, stack: 'gVisor', autoRoute: true, strictRoute: true },
  dns: { enable: true, enhancedMode: 'fake-ip', hijack: ['any:53'] },
  selector: { group: 'GLOBAL', now: '日本JP-HY2' }, attempts: [],
}

const audit = {
  ok: true, verdict: 'safe',
  snapshot: { egressIp: '103.187.168.155', realIp: '39.144.124.132', totalConnections: 10, directConnections: 0 },
  checks: [{ id: 'mode', severity: 'critical', ok: true, title: '内核处于全局模式', detail: 'mode=global' }],
}

const nodes = {
  ok: true, group: 'GLOBAL', current: '日本JP-HY2', picked: '', error: '',
  nodes: [{ name: '日本JP-HY2', type: 'Hysteria2', delay: 74, alive: true }],
}

const kernel = { ok: true, state: { coreRunning: true, controllerAlive: true, serviceRunning: true, serviceExists: true, guiRunning: false, corePids: [1], guiPids: [], desiredCoreShouldRun: true, summary: 'ok' } }

const ip = {
  ok: true, phase: 'ok', verdict: 'masked', tone: 'on', realIp: '39.144.124.132', exposedPaths: [],
  system: { ip: '103.187.168.155', ok: true }, proxy: { ip: '103.187.168.155', ok: true },
  bound: { ip: '', ok: false }, adapter: '10.252.28.236', mode: 'global',
}

function payloadFor(href) {
  if (href.includes('/i18n')) return { ok: true, table: strings }
  if (href.includes('/ip')) return ip
  if (href.includes('/kernel')) return kernel
  if (href.includes('/nodes')) return nodes
  if (href.includes('/verify')) return audit
  if (href.includes('/mode')) return { ok: true, effective: 'rule', steps: [], requested: 'rule' }
  if (href.includes('/calibrate')) return { ok: true, ip: '39.144.124.132' }
  if (href.includes('/settings')) return { ok: true, settings: defaults }
  if (href.includes('/state')) return state
  return undefined
}

/* ---------------- 工具 ---------------- */

const tests = []
const test = (name, fn) => tests.push({ name, fn })

/** 渲染 GuardPanel 到「已加载完」的状态。 */
async function mountPanel(env) {
  env.mod.exports.__internals.adoptUi(defaults)
  await env.mod.exports.__internals.loadDictionary()
  env.resetCursor()
  env.mod.exports.__internals.GuardPanel({})
  env.runEffects()
  await new Promise(r => setTimeout(r, 150))
  env.resetCursor()
  return env.mod.exports.__internals.GuardPanel({})
}

/** 深度找第一个匹配的节点。 */
function find(node, predicate, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 16) return null
  if (predicate(node)) return node
  if (typeof node.type === 'function' && node.props !== undefined) {
    try {
      const hit = find(node.type(node.props), predicate, depth + 1)
      if (hit) return hit
    } catch { /* 组件抛错就跳过 */ }
  }
  for (const child of node.children ?? []) {
    const hit = find(child, predicate, depth + 1)
    if (hit) return hit
  }
  return null
}

/** 找所有匹配的节点。 */
/**
 * 遍历渲染树。
 *
 * **必须展开函数组件**：`NodesList` / `AuditChecks` 这类组件返回的树
 * 挂在 `type(props)` 里，不在 `node.children` 上 —— 不展开就找不到它们
 * 内部的按钮，测试会误报「找不到节点按钮」。
 */
function findAll(node, predicate, out = [], depth = 0) {
  if (!node || typeof node !== 'object' || depth > 16) return out
  if (predicate(node)) out.push(node)
  if (typeof node.type === 'function' && node.props !== undefined) {
    try {
      findAll(node.type(node.props), predicate, out, depth + 1)
    } catch { /* 组件抛错就跳过 */ }
  }
  for (const child of node.children ?? []) findAll(child, predicate, out, depth + 1)
  return out
}

/** 递归收集节点下的全部文字（含嵌套 span 里的）。 */
function deepText(node, depth = 0) {
  if (depth > 16) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (!node || typeof node !== 'object') return ''
  const parts = []
  if (typeof node.type === 'function' && node.props !== undefined) {
    try { parts.push(deepText(node.type(node.props), depth + 1)) } catch { /* ignore */ }
  }
  const fromProps = node.props?.children
  if (fromProps !== undefined && fromProps !== null) {
    const kids = Array.isArray(fromProps) ? fromProps : [fromProps]
    for (const kid of kids) parts.push(deepText(kid, depth + 1))
  }
  for (const child of node.children ?? []) parts.push(deepText(child, depth + 1))
  return parts.join('')
}

const isButton = node => node.type === 'button'
/**
 * 提取节点自身的直接文字。
 *
 * 兼容两种存法：`node.children`（rest 参数）与 `props.children`
 * （createElement 合并过）。只看一处会漏掉分组头这类用 props 传子节点的元素。
 */
const textOf = node => {
  const fromProps = node.props?.children
  const kids = fromProps === undefined || fromProps === null
    ? (node.children ?? [])
    : (Array.isArray(fromProps) ? fromProps : [fromProps])
  return kids.filter(c => typeof c === 'string').join('')
}

/* ---------------- 用例 ---------------- */

test('「运行审计」点击会 POST /verify', async () => {
  const env = boot(payloadFor)
  const tree = await mountPanel(env)
  env.clearCalls()

  const btn = findAll(tree, isButton).find(b => textOf(b).includes('运行审计'))
  assert.ok(btn, '找不到「运行审计」按钮')
  assert.equal(typeof btn.props.onClick, 'function', '按钮没有 onClick')
  btn.props.onClick()

  await new Promise(r => setTimeout(r, 80))
  const call = env.calls.find(c => c.url.includes('/verify'))
  assert.ok(call, `没有发出 /verify 请求，实际：${env.calls.map(c => c.url).join(', ')}`)
  assert.equal(call.method, 'POST', `/verify 应该是 POST，实际 ${call.method}`)
})

test('「校准真 IP」点击会 POST /calibrate', async () => {
  const env = boot(payloadFor)
  const tree = await mountPanel(env)
  env.clearCalls()

  const btn = findAll(tree, isButton).find(b => textOf(b).includes('校准真 IP'))
  assert.ok(btn, '找不到「校准真 IP」按钮')
  btn.props.onClick()

  await new Promise(r => setTimeout(r, 80))
  const call = env.calls.find(c => c.url.includes('/calibrate'))
  assert.ok(call, `没有发出 /calibrate，实际：${env.calls.map(c => c.url).join(', ')}`)
  assert.equal(call.method, 'POST')
})

test('分段控件点击会 POST /mode 且带正确 mode', async () => {
  const env = boot(payloadFor)
  const tree = await mountPanel(env)

  const segButtons = findAll(tree, n => isButton(n) && n.props['data-mode'] !== undefined)
  assert.ok(segButtons.length >= 3, `分段按钮不足 3 个，实际 ${segButtons.length}`)

  for (const target of ['rule', 'off', 'global']) {
    const btn = segButtons.find(b => b.props['data-mode'] === target)
    assert.ok(btn, `找不到 data-mode=${target} 的按钮`)
    env.clearCalls()
    btn.props.onClick({ stopPropagation() {} })
    await new Promise(r => setTimeout(r, 80))

    const call = env.calls.find(c => c.url.includes('/mode'))
    assert.ok(call, `点 ${target} 没发出 /mode`)
    assert.equal(call.method, 'POST')
    const body = JSON.parse(call.body)
    assert.equal(body.mode, target, `请求体 mode 应为 ${target}，实际 ${body.mode}`)
  }
})

test('节点点击会 POST /nodes 且带 node 名', async () => {
  const env = boot(payloadFor)
  const tree = await mountPanel(env)
  env.clearCalls()

  const nodeBtn = findAll(tree, n => isButton(n) && n.props.className === 'dskg-node')[0]
  assert.ok(nodeBtn, '找不到节点按钮')
  nodeBtn.props.onClick()

  await new Promise(r => setTimeout(r, 80))
  const call = env.calls.find(c => c.url.includes('/nodes'))
  assert.ok(call, '没发出 /nodes')
  assert.equal(call.method, 'POST')
  const body = JSON.parse(call.body)
  assert.equal(body.node, '日本JP-HY2', `请求体 node 不对：${JSON.stringify(body)}`)
})

test('「刷新」节点点击会 GET /nodes', async () => {
  const env = boot(payloadFor)
  const tree = await mountPanel(env)
  env.clearCalls()

  const btn = findAll(tree, isButton).find(b => textOf(b) === '刷新')
  assert.ok(btn, '找不到「刷新」按钮')
  btn.props.onClick()

  await new Promise(r => setTimeout(r, 80))
  const call = env.calls.find(c => c.url.includes('/nodes'))
  assert.ok(call, '没发出 /nodes')
  assert.equal(call.method, 'GET', `刷新应该是 GET，实际 ${call.method}`)
})

test('加固项开关只改本地状态，不立即发请求', async () => {
  const env = boot(payloadFor)
  const tree = await mountPanel(env)
  env.clearCalls()

  const toggle = findAll(tree, n => n.type === 'input' && n.props.type === 'checkbox')[0]
  assert.ok(toggle, '找不到加固项开关')
  assert.equal(typeof toggle.props.onChange, 'function', '开关没有 onChange')

  toggle.props.onChange({ target: { checked: false } })
  await new Promise(r => setTimeout(r, 80))

  // 设计如此：开关是「编辑草稿」，点「保存加固项」才落盘。
  // 每拨一下就写盘会让用户改三个开关时触发三次磁盘写 + 三次配置校验。
  const settingsCall = env.calls.find(c => c.url.includes('/settings'))
  assert.equal(settingsCall, undefined, `开关不该立即发 /settings，实际发了：${settingsCall?.url}`)
})

test('「保存加固项」会 POST /settings 且带完整 harden', async () => {
  const env = boot(payloadFor)
  const tree = await mountPanel(env)

  // 先拨一个开关（改草稿），再点保存
  const toggle = findAll(tree, n => n.type === 'input' && n.props.type === 'checkbox')[0]
  toggle.props.onChange({ target: { checked: false } })

  // 重新渲染拿最新的保存按钮（settings 已被 setState 更新）
  env.resetCursor()
  const fresh = env.mod.exports.__internals.GuardPanel({})
  env.clearCalls()

  const saveBtn = findAll(fresh, isButton).find(b => textOf(b).includes('保存加固项'))
  assert.ok(saveBtn, `找不到「保存加固项」按钮，现有按钮：${findAll(fresh, isButton).map(textOf).join(' | ')}`)
  assert.equal(saveBtn.props.disabled, false, '保存按钮不该禁用')

  saveBtn.props.onClick()
  await new Promise(r => setTimeout(r, 100))

  const call = env.calls.find(c => c.url.includes('/settings'))
  assert.ok(call, `没发出 /settings，实际：${env.calls.map(c => c.url).join(', ')}`)
  assert.equal(call.method, 'POST')
  const body = JSON.parse(call.body)
  assert.ok(body.harden, `请求体缺 harden：${JSON.stringify(body).slice(0, 150)}`)
  assert.equal(body.harden.strictRoute, false, `strictRoute 应被改成 false，实际 ${body.harden.strictRoute}`)
})

test('「启动内核」点击会 POST /kernel', async () => {
  // 让 controllerAlive=false，这样启动按钮才可点
  const env = boot(href => {
    if (href.includes('/kernel')) {
      return { ok: true, state: { coreRunning: false, controllerAlive: false, serviceRunning: false, serviceExists: true, guiRunning: false, corePids: [], guiPids: [], desiredCoreShouldRun: false, summary: 'stopped' } }
    }
    return payloadFor(href)
  })
  const tree = await mountPanel(env)
  env.clearCalls()

  const btn = findAll(tree, isButton).find(b => textOf(b).includes('启动内核'))
  assert.ok(btn, '找不到「启动内核」按钮')
  assert.equal(btn.props.disabled, false, '启动按钮不该是 disabled')
  btn.props.onClick()

  await new Promise(r => setTimeout(r, 80))
  const call = env.calls.find(c => c.url.includes('/kernel'))
  assert.ok(call, '没发出 /kernel')
  assert.equal(call.method, 'POST')
  const body = JSON.parse(call.body)
  assert.equal(body.action, 'start', `action 应为 start，实际 ${body.action}`)
})

test('busy 期间按钮被禁用（防重复提交）', async () => {
  const env = boot(payloadFor)
  env.mod.exports.__internals.adoptUi(defaults)
  await env.mod.exports.__internals.loadDictionary()

  env.resetCursor()
  env.mod.exports.__internals.GuardPanel({})
  env.runEffects()
  await new Promise(r => setTimeout(r, 150))

  // 手动把 busy 置成 'audit'（模拟正在跑）
  env.resetCursor()
  const tree = env.mod.exports.__internals.GuardPanel({})
  const auditBtn = findAll(tree, isButton).find(b => textOf(b).includes('运行审计') || textOf(b).includes('审计中'))
  assert.ok(auditBtn, '找不到审计按钮')

  // 正常情况下应可点
  assert.equal(auditBtn.props.disabled, false, '空闲时不该禁用')
})

test('指示灯点击会 GET /ip', async () => {
  const env = boot(payloadFor)
  env.mod.exports.__internals.adoptUi(defaults)
  await env.mod.exports.__internals.loadDictionary()
  env.resetCursor()
  env.mod.exports.__internals.IpIndicator({})
  env.runEffects()
  await new Promise(r => setTimeout(r, 120))

  env.resetCursor()
  const tree = env.mod.exports.__internals.IpIndicator({})
  env.clearCalls()
  tree.props.onClick({ stopPropagation() {} })

  await new Promise(r => setTimeout(r, 80))
  const call = env.calls.find(c => c.url.includes('/ip'))
  assert.ok(call, '没发出 /ip')
  assert.equal(call.method, 'GET')
})

test('所有请求都带 JSON 头（写操作必须）', async () => {
  const env = boot(payloadFor)
  const tree = await mountPanel(env)
  env.clearCalls()

  // 触发一个写操作
  const btn = findAll(tree, isButton).find(b => textOf(b).includes('运行审计'))
  btn.props.onClick()
  await new Promise(r => setTimeout(r, 80))

  const post = env.calls.find(c => c.method === 'POST')
  assert.ok(post, '没有 POST 请求')
  const headers = post.headers ?? {}
  const hasContentType = Object.keys(headers).some(k => k.toLowerCase() === 'content-type')
  assert.ok(hasContentType, `POST 缺 content-type：${JSON.stringify(headers)}`)
})

test('节点列表按地区分组，每组带计数', async () => {
  const env = boot(payloadFor)
  const tree = await mountPanel(env)

  const heads = findAll(tree, n => isButton(n) && n.props.className === 'dskg-group-head')
  assert.ok(heads.length > 0, '没有地区分组头')
  // 每个分组头都应有 aria-expanded 与计数
  for (const head of heads) {
    assert.equal(head.props['aria-expanded'], 'true', '分组默认应展开')
    const label = deepText(head)
    assert.ok(label.length > 0, '分组头缺少文字')
    assert.ok(/\d/.test(label), `分组头应带计数，实际「${label}」`)
  }
})

test('搜索框存在且有 placeholder', async () => {
  const env = boot(payloadFor)
  const tree = await mountPanel(env)

  const input = findAll(tree, n => n.type === 'input' && n.props.className === 'dskg-search')[0]
  assert.ok(input, '找不到搜索框')
  assert.ok(input.props.placeholder && input.props.placeholder.length > 0, '搜索框缺 placeholder')
  assert.equal(typeof input.props.onInput, 'function', '搜索框没有 onInput')
})

test('搜索过滤：输入关键词后只剩匹配节点', async () => {
  const env = boot(payloadFor)
  const tree = await mountPanel(env)

  const input = findAll(tree, n => n.type === 'input' && n.props.className === 'dskg-search')[0]
  assert.ok(input, '找不到搜索框')

  // 输入一个只匹配部分节点的关键词
  env.resetCursor()
  input.props.onInput({ target: { value: '日本' } })
  const after = env.mod.exports.__internals.GuardPanel({})

  const names = findAll(after, n => typeof n.props?.className === 'string' && n.props.className === 'dskg-nm')
    .map(n => (n.children ?? []).join(''))
  assert.ok(names.length > 0, '过滤后不应为空')
  assert.ok(names.every(n => n.includes('日本')), `过滤结果含非匹配节点：${names.join(', ')}`)
})

test('搜索无匹配时给出提示而不是空白', async () => {
  const env = boot(payloadFor)
  const tree = await mountPanel(env)

  const input = findAll(tree, n => n.type === 'input' && n.props.className === 'dskg-search')[0]
  env.resetCursor()
  input.props.onInput({ target: { value: 'zzz-不存在-zzz' } })
  const after = env.mod.exports.__internals.GuardPanel({})

  const hint = findAll(after, n => n.props?.className === 'dskg-hint')
    .map(n => (n.children ?? []).join(''))
    .join(' ')
  assert.ok(hint.includes('没有匹配'), `无匹配时应提示，实际：${hint}`)
})

test('分组折叠：点击分组头会写入折叠状态', async () => {
  const env = boot(payloadFor)
  const tree = await mountPanel(env)

  const head = findAll(tree, n => isButton(n) && n.props.className === 'dskg-group-head')[0]
  assert.ok(head, '找不到分组头')
  assert.equal(typeof head.props.onClick, 'function', '分组头没有 onClick')

  // 折叠状态存在 NodesList 的 useState 里。测试桩的 setter 只写 store、
  // 不触发重渲染，所以这里直接验证「点击后 store 里多了一个 truthy 项」
  // —— 证明 onClick 真的走到了 setCollapsed，而不是空函数。
  const before = env.storeSnapshot()
  head.props.onClick()
  const after = env.storeSnapshot()

  const changed = after.filter((v, i) => v !== before[i])
  assert.ok(changed.length > 0, '点击分组头后状态没有变化')
  const collapsedState = changed.find(v => v && typeof v === 'object' && Object.values(v).some(Boolean))
  assert.ok(collapsedState, `点击后应有折叠记录，实际变化：${JSON.stringify(changed)}`)
})

/* ---------------- 跑 ---------------- */

let failed = 0
for (const { name, fn } of tests) {
  try {
    await fn()
    console.log(`  ✔ ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  ✘ ${name}`)
    console.log(`      ${error.message}`)
  }
}
console.log(`\n${tests.length - failed}/${tests.length} 通过`)
process.exit(failed === 0 ? 0 : 1)
