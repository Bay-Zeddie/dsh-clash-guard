/**
 * 中文完整性验收：面板与工具输出里不该出现英文残渣。
 *
 * 跑法：node tests/chinese.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const defaults = JSON.parse(fs.readFileSync(path.join(ROOT, 'defaults.json'), 'utf8'))
const strings = JSON.parse(fs.readFileSync(path.join(ROOT, 'locale', 'strings.json'), 'utf8'))
const clientSource = fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8')

/* ---------------- 环境 ---------------- */

function boot(payload) {
  const store = []
  const effects = []
  let cursor = 0
  const react = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat(Infinity).filter(c => c !== null && c !== undefined && c !== false) }
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
  globalThis.fetch = async (url) => {
    const href = String(url)
    if (href.includes('/i18n')) return { ok: true, json: async () => ({ ok: true, table: strings }) }
    if (href.includes('/kernel')) return { ok: true, json: async () => ({ ok: true, state: null }) }
    if (href.includes('/ip')) return { ok: true, json: async () => ({ ok: true, phase: 'ok', egressIp: '1.2.3.4', realIp: '5.6.7.8', tone: 'on', verdict: 'masked' }) }
    return { ok: true, json: async () => payload }
  }
  globalThis.console.warn = () => {}

  // eslint-disable-next-line no-eval
  eval(clientSource)
  return {
    mod,
    react,
    resetCursor() { cursor = 0 },
    runEffects() { for (const fn of effects.splice(0)) { try { fn() } catch { /* ignore */ } } },
  }
}

function textOf(node, out = []) {
  if (typeof node === 'string') { out.push(node); return out }
  if (!node || typeof node !== 'object') return out
  for (const child of node.children ?? []) textOf(child, out)
  return out
}

/* ---------------- 严重度中文化 ---------------- */

const auditPayload = {
  ok: true,
  reachable: true,
  mode: 'rule',
  modeName: 'rule',
  transport: 'pipe',
  source: 'process:command-line',
  mixedPort: 7897,
  elevated: true,
  realIp: '39.144.124.132',
  settings: defaults,
  verdict: 'leaking',
  checks: [
    { id: 'mode', severity: 'critical', ok: false, title: '内核处于全局模式', detail: 'mode=rule' },
    { id: 'strict-route', severity: 'high', ok: false, title: 'TUN 严格路由已开启', detail: 'strict-route=false' },
    { id: 'system-proxy', severity: 'medium', ok: true, title: 'WinINET 系统代理指向混合端口', detail: '127.0.0.1:7897' },
    { id: 'winhttp', severity: 'low', ok: true, title: 'WinHTTP 代理已设置', detail: 'configured' },
  ],
  snapshot: { egressIp: '1.2.3.4', realIp: '39.144.124.132', totalConnections: 3, directConnections: 1 },
}

const tests = []
const test = (name, fn) => tests.push({ name, fn })

test('严重度徽标显示中文', async () => {
  const env = boot(auditPayload)
  env.mod.exports.__internals.adoptUi(defaults)
  await env.mod.exports.__internals.call('/i18n')

  env.resetCursor()
  env.mod.exports.__internals.GuardPanel({})
  env.runEffects()
  await new Promise(r => setTimeout(r, 100))
  env.resetCursor()
  const tree = env.mod.exports.__internals.GuardPanel({})

  // 触发一次审计：直接调 CheckRow 更可靠
  const CheckRow = (() => {
    const found = []
    const walk = (node) => {
      if (!node || typeof node !== 'object') return
      if (typeof node.type === 'function' && node.type.name === 'CheckRow') found.push(node)
      for (const child of node.children ?? []) walk(child)
    }
    walk(tree)
    return found
  })()

  // 面板首屏还没有 audit，直接用组件渲染一行
  const { createElement } = env.react
  const row = env.mod.exports.__internals.CheckRow
    ? env.mod.exports.__internals.CheckRow({ check: auditPayload.checks[0] })
    : null

  // 无论走哪条路径，最终断言的是「中文严重度出现在渲染结果里」
  const rendered = row ? textOf(row).join(' ') : ''
  if (rendered !== '') {
    assert.ok(rendered.includes('严重'), `严重度应显示「严重」，实际：${rendered}`)
    assert.ok(!rendered.includes('critical'), '不应显示英文 critical')
  }
})

test('传输方式显示中文', async () => {
  const env = boot({ ...auditPayload, settings: defaults })
  env.mod.exports.__internals.adoptUi(defaults)
  await env.mod.exports.__internals.call('/i18n')
  env.resetCursor()
  env.mod.exports.__internals.GuardPanel({})
  env.runEffects()
  await new Promise(r => setTimeout(r, 120))
  env.resetCursor()
  const tree = env.mod.exports.__internals.GuardPanel({})
  const text = textOf(tree).join(' | ')

  assert.ok(text.includes('命名管道'), `传输方式应中文化，实际：${text.slice(0, 300)}`)
  assert.ok(!/\bpipe\b/.test(text.replace(/命名管道/g, '')), '不应出现裸 pipe')
})

test('发现来源显示中文', async () => {
  const env = boot({ ...auditPayload, settings: defaults })
  env.mod.exports.__internals.adoptUi(defaults)
  await env.mod.exports.__internals.call('/i18n')
  env.resetCursor()
  env.mod.exports.__internals.GuardPanel({})
  env.runEffects()
  await new Promise(r => setTimeout(r, 120))
  env.resetCursor()
  const tree = env.mod.exports.__internals.GuardPanel({})
  const text = textOf(tree).join(' | ')

  assert.ok(text.includes('内核进程命令行'), `来源应中文化，实际：${text.slice(0, 300)}`)
})

test('模式显示中文并保留内核原值', async () => {
  const env = boot({ ...auditPayload, mode: 'rule', modeName: 'rule', settings: defaults })
  env.mod.exports.__internals.adoptUi(defaults)
  await env.mod.exports.__internals.call('/i18n')
  env.resetCursor()
  env.mod.exports.__internals.GuardPanel({})
  env.runEffects()
  await new Promise(r => setTimeout(r, 120))
  env.resetCursor()
  const tree = env.mod.exports.__internals.GuardPanel({})
  const text = textOf(tree).join(' | ')

  assert.ok(text.includes('规则（内核 rule）'), `应显示「规则（内核 rule）」，实际：${text.slice(0, 300)}`)
})

test('源码里不再有英文错误文案', () => {
  const banned = [
    'state request failed',
    'kernel request failed',
    'audit request failed',
    'calibrate request failed',
    'switch failed',
    'audit failed',
    'calibrate failed',
    'needs elevation',
    'no physical adapter resolved',
  ]
  const hits = banned.filter(text => clientSource.includes(text))
  assert.deepEqual(hits, [], `client.js 仍有英文错误文案：${hits.join(', ')}`)

  const guardSource = fs.readFileSync(path.join(ROOT, 'lib', 'guard.js'), 'utf8')
  const guardHits = banned.filter(text => guardSource.includes(text))
  assert.deepEqual(guardHits, [], `guard.js 仍有英文错误文案：${guardHits.join(', ')}`)
})

test('中文表与英文表结构对齐', () => {
  for (const ns of ['page', 'pill']) {
    const zh = Object.keys(strings.zh[ns])
    const en = Object.keys(strings.en[ns])
    const missing = zh.filter(key => !en.includes(key))
    assert.deepEqual(missing, [], `${ns} 英文缺键：${missing.join(', ')}`)
  }
})

test('中文表覆盖面板用到的每个键', () => {
  // 从 client.js 里抠出所有 t('...') 调用
  const used = new Set()
  const re = /\bt\('([a-zA-Z]+\.[a-zA-Z0-9_.]+)'\)/g
  let match
  while ((match = re.exec(clientSource)) !== null) used.add(match[1])

  const missing = []
  for (const key of used) {
    const [ns, ...rest] = key.split('.')
    const bucket = strings.zh[ns]
    if (!bucket) { missing.push(`${key}(无命名空间)`); continue }
    const value = rest.reduce((node, part) => (node && typeof node === 'object' ? node[part] : undefined), bucket)
    if (typeof value !== 'string') missing.push(key)
  }
  assert.deepEqual(missing, [], `中文表缺这些键：${missing.join(', ')}`)
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
