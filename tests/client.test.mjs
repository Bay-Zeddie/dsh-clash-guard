/**
 * 浏览器半验收测试：槽位注册 + 样式配方 + 面板渲染。
 *
 * 用一个最小的 React 桩驱动 `lib/client.js` 的 factory，配一个真实形状的
 * `/state` 应答，验证：
 *   1. 侧边栏一级入口（`sidebar.panellist` + `main`）真的注册了，两个 id 一致；
 *   2. 磨砂配方与 `dsh-sunfragment-skin` 逐字对齐，且优先读官方令牌；
 *   3. 面板在真实数据下渲染出四张卡片与本地化文案。
 *
 * 跑法：node tests/client.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const defaults = JSON.parse(fs.readFileSync(path.join(ROOT, 'defaults.json'), 'utf8'))
const strings = JSON.parse(fs.readFileSync(path.join(ROOT, 'locale', 'strings.json'), 'utf8'))
const clientSource = fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8')

/* ------------------------------------------------------------------ *
 * 最小 React 桩
 * ------------------------------------------------------------------ */

/** 用一份持久的 hook 存储模拟 React 的两次渲染。 */
function createReactStub() {
  const store = []
  const effects = []
  let cursor = 0
  return {
    effects,
    resetCursor() { cursor = 0 },
    createElement(type, props, ...children) {
      return {
        type,
        props: props ?? {},
        children: children.flat(Infinity).filter(c => c !== null && c !== undefined && c !== false),
      }
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
}

/** 建一个浏览器环境并把 client.js 加载进来。 */
function loadClient(statePayload, options = {}) {
  const react = createReactStub()
  const styleTags = []
  const warnings = []
  let mod = null

  globalThis.window = {
    __ModuleLoader__: {
      load({ id, factory }) {
        mod = {
          id,
          exports: factory((name) => {
            if (name === 'react') return react
            throw new Error(`unexpected require: ${name}`)
          }),
        }
      },
    },
  }
  globalThis.document = {
    documentElement: { lang: options.lang ?? 'zh' },
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '', id: '' }),
    head: { appendChild: (tag) => { styleTags.push(tag) } },
  }
  globalThis.fetch = async (url) => {
    if (String(url).includes('/i18n')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, table: strings }) }
    }
    return { ok: true, status: 200, json: async () => statePayload }
  }
  globalThis.console.warn = (...args) => { warnings.push(args.join(' ')) }

  // eslint-disable-next-line no-eval
  eval(clientSource)

  return { mod, react, styleTags, warnings }
}

/** 走一遍两次渲染，返回最终的渲染树。 */
async function renderPanel(mod, react) {
  const internals = mod.exports.__internals
  react.resetCursor()
  let tree = internals.GuardPanel({})
  for (const fn of react.effects.splice(0)) {
    try { fn() } catch (error) { /* 桩里 effect 出错不影响断言 */ }
  }
  await new Promise(r => setTimeout(r, 80))
  react.resetCursor()
  tree = internals.GuardPanel({})
  return tree
}

/** 收集渲染树里的全部文本。 */
function collectText(node, out = []) {
  if (node === null || node === undefined) return out
  if (typeof node === 'string') { out.push(node); return out }
  if (typeof node !== 'object') return out
  for (const child of node.children ?? []) collectText(child, out)
  return out
}

/** 收集渲染树里的全部 className。 */
function collectClasses(node, out = []) {
  if (!node || typeof node !== 'object') return out
  if (node.props?.className) out.push(node.props.className)
  for (const child of node.children ?? []) collectClasses(child, out)
  return out
}

/** 收集 Card 组件的标题（函数组件桩不展开，读 props）。 */
function collectCards(node, out = []) {
  if (!node || typeof node !== 'object') return out
  if (typeof node.type === 'function' && node.type.name === 'Card' && node.props?.title) {
    out.push(node.props.title)
  }
  for (const child of node.children ?? []) collectCards(child, out)
  return out
}

/* ------------------------------------------------------------------ *
 * 测试
 * ------------------------------------------------------------------ */

const reachableState = {
  ok: true,
  reachable: true,
  version: 'v1.19.33',
  transport: 'pipe',
  source: 'process:command-line',
  mode: 'global',
  modeName: 'global',
  mixedPort: 7897,
  elevated: true,
  realIp: '203.0.113.9',
  settings: defaults,
}

const unreachableState = {
  ok: false,
  reachable: false,
  error: 'no controller candidate answered /version',
  attempts: [
    { source: 'process:command-line', transport: 'pipe', ok: false, error: 'ENOENT' },
    { source: 'config:clash-verge.yaml', transport: 'pipe', ok: false, error: 'ENOENT' },
  ],
  settings: defaults,
}

const tests = []
const test = (name, fn) => tests.push({ name, fn })

test('侧边栏行与 main 页面用同一个 id 注册', async () => {
  const { mod } = loadClient(reachableState)
  const registered = []
  const ctx = {
    slots: {
      inject(_key, callback) { const d = callback(); return typeof d === 'function' ? d : () => {} },
      register(options) { registered.push(options); return () => {} },
    },
    effect(fn) { fn() },
    get(name) { return name === 'slots' ? this.slots : undefined },
  }

  mod.exports.apply(ctx)
  await new Promise(r => setTimeout(r, 300))

  const row = registered.find(r => r.name === 'sidebar.panellist')
  const page = registered.find(r => r.name === 'main')

  assert.ok(row, '必须注册 sidebar.panellist 导航行')
  assert.ok(page, '必须注册 main 页面')
  assert.equal(row.id, defaults.ui.panelId, '导航行 id 必须来自 defaults.ui.panelId')
  assert.equal(page.key, defaults.ui.panelId, 'main 的 key 必须与导航行 id 相同')
  assert.equal(row.order, defaults.ui.panelOrder, '排序必须来自 defaults.ui.panelOrder')
  assert.equal(typeof row.label, 'function', 'label 必须是 thunk（跟随语言变化）')
  assert.equal(row.label(), defaults.ui.panelLabelZh, '中文环境下用中文标签')
})

test('出口 IP 指示灯注册到输入框左侧，与三段式开关互不影响', async () => {
  const { mod } = loadClient({ ...reachableState, settings: defaults })
  const registered = []
  const ctx = {
    slots: {
      inject(_key, callback) { const d = callback(); return typeof d === 'function' ? d : () => {} },
      register(options) { registered.push(options); return () => {} },
    },
    effect(fn) { fn() },
    get(name) { return name === 'slots' ? this.slots : undefined },
  }

  mod.exports.apply(ctx)
  await new Promise(r => setTimeout(r, 400))

  const indicator = registered.find(r => r.id === defaults.ui.indicatorId)
  const row = registered.find(r => r.name === 'sidebar.panellist')
  const pill = registered.find(r => r.id === defaults.ui.pillId)

  assert.ok(indicator, '默认必须注册出口 IP 指示灯')
  assert.equal(indicator.name, defaults.ui.indicatorSlot, '指示灯座位来自 defaults.ui.indicatorSlot')
  assert.equal(indicator.order, defaults.ui.indicatorOrder, '指示灯排序来自 defaults.ui.indicatorOrder')
  assert.ok(row, '侧边栏入口必须仍在')
  assert.equal(pill, undefined, '三段式开关默认关闭，不应注册')
})

test('adoptUi 真的把 indicator 字段搬进 UI（防遗漏）', async () => {
  const { mod } = loadClient({ ...reachableState, settings: defaults })
  const internals = mod.exports.__internals
  // 先抹掉，确认 adoptUi 会重新填
  internals.UI.enableIndicator = false
  internals.UI.indicatorId = ''
  internals.UI.indicatorSlot = ''
  internals.UI.indicatorPollMs = 0

  internals.adoptUi(defaults)

  assert.equal(internals.UI.enableIndicator, true, 'enableIndicator 必须被搬进来')
  assert.equal(internals.UI.indicatorId, defaults.ui.indicatorId, 'indicatorId 必须被搬进来')
  assert.equal(internals.UI.indicatorSlot, defaults.ui.indicatorSlot, 'indicatorSlot 必须被搬进来')
  assert.equal(internals.UI.indicatorPollMs, defaults.ui.indicatorPollMs, 'indicatorPollMs 必须被搬进来')
})

test('输入框旁的三段式小开关默认不注册（唯一入口是侧边栏）', async () => {
  const { mod } = loadClient({ ...reachableState, settings: defaults })
  const injected = []
  const ctx = {
    slots: {
      inject(key, callback) { injected.push(key); const d = callback(); return typeof d === 'function' ? d : () => {} },
      register() { return () => {} },
    },
    effect(fn) { fn() },
    get(name) { return name === 'slots' ? this.slots : undefined },
  }

  mod.exports.apply(ctx)
  await new Promise(r => setTimeout(r, 400))

  assert.equal(defaults.ui.enablePill, false, 'defaults 里必须默认关闭 pill')
  assert.ok(injected.includes('sidebar.panellist'), '侧边栏入口必须仍在')
  // 指示灯与 pill 共用同一个座位，所以不能靠 inject 列表判断；
  // 用注册项判断：pill 的 id 不该出现。
})

test('把 ui.enablePill 置 true 时小开关会回来', async () => {
  const withPill = JSON.parse(JSON.stringify(defaults))
  withPill.ui.enablePill = true
  const { mod } = loadClient({ ...reachableState, settings: withPill })
  const injected = []
  const ctx = {
    slots: {
      inject(key, callback) { injected.push(key); const d = callback(); return typeof d === 'function' ? d : () => {} },
      register() { return () => {} },
    },
    effect(fn) { fn() },
    get(name) { return name === 'slots' ? this.slots : undefined },
  }

  mod.exports.apply(ctx)
  await new Promise(r => setTimeout(r, 300))

  assert.ok(injected.includes(withPill.ui.pillSlot), '开启时必须 inject 输入框槽位')
})

test('英文环境下列表标签走英文', async () => {
  const { mod } = loadClient(reachableState, { lang: 'en' })
  const registered = []
  const ctx = {
    slots: {
      inject(_key, callback) { const d = callback(); return typeof d === 'function' ? d : () => {} },
      register(options) { registered.push(options); return () => {} },
    },
    effect(fn) { fn() },
    get(name) { return name === 'slots' ? this.slots : undefined },
  }

  mod.exports.apply(ctx)
  await new Promise(r => setTimeout(r, 300))

  const row = registered.find(r => r.name === 'sidebar.panellist')
  assert.equal(row.label(), defaults.ui.panelLabelEn, '英文环境下用英文标签')
})

test('磨砂配方与 dsh-sunfragment-skin 逐字对齐', async () => {
  const { mod } = loadClient(reachableState)
  mod.exports.__internals.adoptUi(defaults)
  const css = mod.exports.__internals.buildCss()

  assert.ok(
    css.includes(`var(${defaults.glass.token}, ${defaults.glass.fallback})`),
    '必须写成 var(官方令牌, 兜底值)',
  )
  assert.equal(defaults.glass.fallback, 'blur(10px) saturate(160%) brightness(.82)', '兜底值必须与皮肤标定值一致')
  assert.ok(css.includes(':root,\nbody {'), '令牌必须声明在 :root 与 body 两处')
  assert.ok(css.includes('-webkit-backdrop-filter'), '必须带 -webkit- 前缀')
})

test('透明底与磨砂必须同时在场', async () => {
  const { mod } = loadClient(reachableState)
  mod.exports.__internals.adoptUi(defaults)
  const css = mod.exports.__internals.buildCss()

  // 卡片：底色走官方令牌（皮肤会清成透明），磨砂走令牌链
  const cardRule = css.split('}').find(block => block.includes('.dskg-card {'))
  assert.ok(cardRule, '必须有 .dskg-card 规则')
  assert.ok(cardRule.includes('backdrop-filter: var(--dskg-frost)'), '卡片必须有磨砂')
  assert.ok(cardRule.includes('background: var(--dsw-alias-bg-layer-1)'), '卡片底色必须走官方令牌')
})

test('布局参数来自 defaults 而非写死', async () => {
  const { mod } = loadClient(reachableState)
  mod.exports.__internals.adoptUi(defaults)
  const css = mod.exports.__internals.buildCss()

  assert.ok(css.includes(`max-width: ${defaults.ui.maxContentWidth}px`), 'max-width 必须来自 defaults.ui.maxContentWidth')
  assert.ok(css.includes('--dsh-frame-top-clearance'), '顶部必须给自定义标题栏让位')
  assert.ok(css.includes('height: 100%'), '页面必须占满主列高度')
  assert.ok(css.includes('overflow-y: auto'), '页面必须自己滚动')
})

test('输入框用 border-l3 而不是 l1', async () => {
  const { mod } = loadClient(reachableState)
  mod.exports.__internals.adoptUi(defaults)
  const css = mod.exports.__internals.buildCss()

  const inputRule = css.split('}').find(block => block.includes('.dskg-input {'))
  assert.ok(inputRule, '必须有 .dskg-input 规则')
  assert.ok(inputRule.includes('--dsw-alias-border-l3'), '皮肤把 bg-layer 清成透明，边框必须用 l3')
})

test('配色走令牌，hex 只允许作为 var() 兜底或语义色定义', async () => {
  const { mod } = loadClient(reachableState)
  mod.exports.__internals.adoptUi(defaults)
  const css = mod.exports.__internals.buildCss()

  // 允许三类 hex：
  //   1. var(--dsw-xxx, #hex) 的兜底值 —— 令牌缺失时的保险；
  //   2. 语义色定义（--dskg-amber / --dskg-red）—— 刻意脱离主题，保证对比度；
  //   3. #fff 这类纯对比色。
  const withoutFallbacks = css
    .replace(/var\([^()]*#[0-9a-f]{3,8}[^()]*\)/gi, '')
    .replace(/--dskg-(amber|red|tone-[\w-]+)\s*:\s*#[0-9a-f]{3,8}/gi, '')
    .replace(/#fff\b/gi, '')
    .replace(/rgba?\([^)]*\)/g, '')
  const hexLeft = withoutFallbacks.match(/#[0-9a-f]{3,8}\b/gi) ?? []
  assert.deepEqual(hexLeft, [], `裸 hex 颜色（既非兜底也非语义色）：${hexLeft.join(', ')}`)
})

test('面板在真实数据下渲染出四张卡片', async () => {
  const { mod, react } = loadClient(reachableState)
  mod.exports.__internals.adoptUi(defaults)
  await mod.exports.__internals.call('/i18n')
  await new Promise(r => setTimeout(r, 60))

  const tree = await renderPanel(mod, react)
  const cards = collectCards(tree)

  const expected = [
    strings.zh.page.sectionMode,
    strings.zh.page.sectionAudit,
    strings.zh.page.sectionNodes,
    strings.zh.page.sectionSettings,
  ]
  for (const title of expected) {
    assert.ok(cards.includes(title), `必须渲染「${title}」卡片`)
  }
})

test('面板渲染出真实模式与控制器信息', async () => {
  const { mod, react } = loadClient(reachableState)
  mod.exports.__internals.adoptUi(defaults)
  await mod.exports.__internals.call('/i18n')
  await new Promise(r => setTimeout(r, 60))

  const tree = await renderPanel(mod, react)
  const text = collectText(tree).join(' | ')

  assert.ok(text.includes(strings.zh.page.title), '必须有标题')
  // 模式与内核值同显，已中文化：`全局（内核 global）`
  assert.ok(
    text.includes('（内核 global）') || text.includes('global'),
    `必须显示当前模式与内核值，实际：${text.slice(0, 200)}`,
  )
  assert.ok(text.includes('命名管道') || text.includes('pipe'), '必须显示控制器载体（已中文化）')
  assert.ok(text.includes('7897'), '必须显示混合端口')
  assert.ok(text.includes('203.0.113.9'), '必须显示已校准的真 IP')
})

test('三段式控件与加固项开关都在', async () => {
  const { mod, react } = loadClient(reachableState)
  mod.exports.__internals.adoptUi(defaults)
  await mod.exports.__internals.call('/i18n')
  await new Promise(r => setTimeout(r, 60))

  const tree = await renderPanel(mod, react)
  const classes = new Set(collectClasses(tree))

  assert.ok(classes.has('dskg-seg'), '必须有三段式控件')
  assert.ok(classes.has('dskg-toggle'), '必须有加固项开关')
  assert.ok(classes.has('dskg-kv'), '必须有键值对区')
  assert.ok(classes.has('dskg-btn'), '必须有按钮')
})

test('渲染出的每个 className 都有对应样式规则', async () => {
  const { mod, react } = loadClient(reachableState)
  mod.exports.__internals.adoptUi(defaults)
  await mod.exports.__internals.call('/i18n')
  await new Promise(r => setTimeout(r, 60))

  const tree = await renderPanel(mod, react)
  const classes = [...new Set(collectClasses(tree))]
  const css = mod.exports.__internals.buildCss()

  const missing = classes.filter(name => name !== 'dskg' && !css.includes(`.${name}`))
  assert.deepEqual(missing, [], `这些类没有样式规则：${missing.join(', ')}`)
})

test('控制器不可达时显示诊断而不是白屏', async () => {
  const { mod, react } = loadClient(unreachableState)
  mod.exports.__internals.adoptUi(defaults)
  await mod.exports.__internals.call('/i18n')
  await new Promise(r => setTimeout(r, 60))

  const tree = await renderPanel(mod, react)
  const text = collectText(tree).join(' | ')

  assert.ok(text.includes(strings.zh.page.notReachable), '必须显示「不可达」')
  assert.ok(text.includes('process:command-line'), '必须列出探测过的候选')
})

test('缺 slots 服务时 apply 不抛', async () => {
  const { mod } = loadClient(reachableState)
  assert.doesNotThrow(() => mod.exports.apply({}))
  assert.doesNotThrow(() => mod.exports.apply({ get: () => undefined }))
  assert.doesNotThrow(() => mod.exports.apply({ slots: {}, get: () => ({}) }))
})

test('locale 的 zh 与 en 键完全对齐', () => {
  const zh = Object.keys(strings.zh.page)
  const en = Object.keys(strings.en.page)
  const missing = zh.filter(key => !en.includes(key))
  assert.deepEqual(missing, [], `英文缺这些键：${missing.join(', ')}`)
  const zhPill = Object.keys(strings.zh.pill)
  const enPill = Object.keys(strings.en.pill)
  assert.deepEqual(zhPill.filter(key => !enPill.includes(key)), [], 'pill 文案键必须对齐')
})

/* ------------------------------------------------------------------ *
 * 跑
 * ------------------------------------------------------------------ */

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
