/**
 * 指示灯行为演示：把三种时刻的渲染结果打出来。
 *
 * 跑法：node tests/indicator-demo.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const defaults = JSON.parse(fs.readFileSync(path.join(ROOT, 'defaults.json'), 'utf8'))
const strings = JSON.parse(fs.readFileSync(path.join(ROOT, 'locale', 'strings.json'), 'utf8'))
const source = fs.readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8')

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
        throw new Error(`unexpected: ${name}`)
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

const payload = {
  ok: true,
  phase: 'ok',
  verdict: 'masked',
  tone: 'on',
  realIp: '39.144.124.132',
  exposedPaths: [],
  system: { ip: '103.187.168.155', ok: true },
  proxy: { ip: '103.187.168.155', ok: true },
  bound: { ip: '', ok: false, detail: 'timeout' },
  adapter: '10.252.28.236',
  egressIp: '103.187.168.155',
  mode: 'rule',
  modeName: 'rule',
  settings: defaults,
}

globalThis.fetch = async (url) => {
  const href = String(url)
  if (href.includes('/i18n')) return { ok: true, json: async () => ({ ok: true, table: strings }) }
  return { ok: true, json: async () => payload }
}
globalThis.console.warn = () => {}

// eslint-disable-next-line no-eval
eval(source)

const I = mod.exports.__internals
I.adoptUi(defaults)

function textOf(node, out = []) {
  if (typeof node === 'string') { out.push(node); return out }
  if (!node || typeof node !== 'object') return out
  for (const child of node.children ?? []) textOf(child, out)
  return out
}

function show(title, node) {
  const text = textOf(node).join(' ')
  const tone = node.props['data-tone']
  const checking = node.props['data-checking']
  const refreshing = node.props['data-refreshing']
  const dot = tone === 'on' ? '🟢' : tone === 'off' ? '🔴' : tone === 'checking' ? '⚪' : '🟡'
  console.log(`\n${title}`)
  console.log(`  ${dot}  ${text}`)
  console.log(`  data-tone=${tone}  data-checking=${checking}  data-refreshing=${refreshing}`)
  console.log(`  title 首行: ${String(node.props.title).split('\n')[0]}`)
}

// 1. 首屏（还没结论）
await I.loadDictionary()
await new Promise(r => setTimeout(r, 40))
cursor = 0
show('【首屏】还没有任何结论', I.IpIndicator({}))

// 2. 拿到结论后
cursor = 0
I.IpIndicator({})
for (const fn of effects.splice(0)) { try { fn() } catch { /* ignore */ } }
await new Promise(r => setTimeout(r, 120))
cursor = 0
const settled = I.IpIndicator({})
show('【有结论】后台空闲', settled)

// 3. 后台刷新中
settled.props.onClick({ stopPropagation() {} })
cursor = 0
show('【有结论】后台刷新中（文案不变）', I.IpIndicator({}))

console.log('\n=== 结论 ===')
console.log('  常显文案永远是结论（已隐藏 / 真 IP 暴露 / 可绕过 / 待校准）')
console.log('  「正在后台刷新…」只出现在悬停提示里')
console.log('  只有首屏从未拿到结论时才显示「检测中」')
