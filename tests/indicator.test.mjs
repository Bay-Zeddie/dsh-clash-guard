/**
 * 出口 IP 指示灯的渲染测试。
 *
 * 用一个能持久化状态并正确驱动「effect → 异步 setState → 二次渲染」的
 * React 桩，验证它在五种真实结局下的圆点色与文案：
 *
 *   masked        出口 ≠ 真 IP     → 绿点
 *   exposed       出口 = 真 IP     → 红点（这是要命的那一种）
 *   uncalibrated  还没校准真 IP    → 黄点
 *   unreachable   控制器不可达     → 红点
 *   no-egress     代理端口无应答   → 黄点
 *
 * 跑法：node tests/indicator.test.mjs
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
 * React 桩：这次要真的驱动异步
 * ------------------------------------------------------------------ */

function boot(ipPayload) {
  const store = []
  const effects = []
  let cursor = 0

  const react = {
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
    documentElement: { lang: 'zh' },
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '', id: '' }),
    head: { appendChild() {} },
  }
  globalThis.fetch = async (url) => {
    const href = String(url)
    if (href.includes('/i18n')) return { ok: true, json: async () => ({ ok: true, table: strings }) }
    if (href.includes('/ip')) return { ok: true, json: async () => ipPayload }
    return { ok: true, json: async () => ({ ok: true, reachable: true, settings: defaults }) }
  }
  globalThis.console.warn = () => {}

  // eslint-disable-next-line no-eval
  eval(clientSource)

  return {
    mod,
    react,
    resetCursor() { cursor = 0 },
    runEffects() {
      for (const fn of effects.splice(0)) {
        try { fn() } catch { /* 桩里 effect 出错不影响断言 */ }
      }
    },
  }
}

/** 渲染一次、跑 effect、等异步落地、再渲染一次。 */
async function render(env) {
  const internals = env.mod.exports.__internals
  env.resetCursor()
  internals.IpIndicator({})
  env.runEffects()
  // /ip 的应答是异步的；给两轮宏任务让它落地
  await new Promise(r => setTimeout(r, 60))
  env.resetCursor()
  return internals.IpIndicator({})
}

/** 取渲染树里的文本。 */
function textOf(node, out = []) {
  if (typeof node === 'string') { out.push(node); return out }
  if (!node || typeof node !== 'object') return out
  for (const child of node.children ?? []) textOf(child, out)
  return out
}

/* ------------------------------------------------------------------ *
 * 五种结局
 * ------------------------------------------------------------------ */

const cases = [
  {
    name: 'masked：出口 ≠ 真 IP → 绿点',
    payload: {
      ok: true, phase: 'ok', egressIp: '54.250.32.156', realIp: '39.144.124.132',
      tone: 'on', verdict: 'masked', mode: 'global', modeName: 'global', checkedAt: 1,
    },
    tone: 'on',
    labelKey: 'indicator.masked',
  },
  {
    name: 'exposed：出口 = 真 IP → 红点',
    payload: {
      ok: true, phase: 'ok', egressIp: '39.144.124.132', realIp: '39.144.124.132',
      tone: 'off', verdict: 'exposed', mode: 'direct', modeName: 'off', checkedAt: 1,
    },
    tone: 'off',
    labelKey: 'indicator.exposed',
  },
  {
    name: 'uncalibrated：未校准 → 空心琥珀环（实心=已知，空心=未知）',
    payload: {
      ok: true, phase: 'ok', egressIp: '54.250.32.156', realIp: '',
      tone: 'warn', verdict: 'uncalibrated', mode: 'rule', modeName: 'rule', checkedAt: 1,
    },
    tone: 'unknown',
    labelKey: 'indicator.uncalibrated',
  },
  {
    name: 'unreachable：控制器不可达 → 红点',
    payload: {
      ok: false, phase: 'unreachable', egressIp: '', realIp: '1.2.3.4', tone: 'off', error: 'controller unreachable',
    },
    tone: 'off',
    labelKey: 'indicator.unreachable',
  },
  {
    name: 'no-egress：代理端口无应答 → 灰点（测不到，不是风险）',
    payload: {
      ok: false, phase: 'no-egress', egressIp: '', realIp: '1.2.3.4', tone: 'warn', error: 'timeout',
    },
    tone: 'idle',
    labelKey: 'indicator.noEgress',
  },
]

let failed = 0
let index = 0
for (const item of cases) {
  index += 1
  try {
    const env = boot(item.payload)
    env.mod.exports.__internals.adoptUi(defaults)
    await env.mod.exports.__internals.call('/i18n')
    const tree = await render(env)

    const tone = tree.props['data-tone']
    const texts = textOf(tree)
    const expected = strings.zh.indicator[item.labelKey.replace('indicator.', '')]

    assert.equal(tone, item.tone, `圆点 tone 应为 ${item.tone}，实际 ${tone}`)
    assert.ok(texts.includes(expected), `文案应含「${expected}」，实际 ${texts.join(' | ')}`)
    assert.ok(texts.includes(strings.zh.indicator.label), '必须带固定标签')

    const dot = tree.children.find(child => child.props?.className === 'dsip-dot')
    assert.ok(dot, '必须有圆点元素')
    assert.equal(dot.props['data-tone'], item.tone, '圆点自己的 data-tone 也要对')

    console.log(`  ✔ ${item.name}`)
  } catch (error) {
    failed += 1
    console.log(`  ✘ ${item.name}`)
    console.log(`      ${error.message}`)
  }
}

/* ------------------------------------------------------------------ *
 * 结构与可访问性
 * ------------------------------------------------------------------ */

try {
  const env = boot(cases[0].payload)
  env.mod.exports.__internals.adoptUi(defaults)
  await env.mod.exports.__internals.call('/i18n')
  const tree = await render(env)

  assert.equal(tree.type, 'button', '根必须是 button（可聚焦、可回车）')
  assert.equal(tree.props.type, 'button', 'button 的 type 必须显式写')
  assert.ok(typeof tree.props.title === 'string' && tree.props.title.length > 0, '必须有 title 提示')
  assert.ok(typeof tree.props['aria-label'] === 'string' && tree.props['aria-label'].length > 0, '必须有 aria-label')
  assert.ok(tree.props.title.includes(strings.zh.indicator.tipClick), 'title 里要告诉用户点击可重测')
  console.log('  ✔ 结构：button + title + aria-label')
} catch (error) {
  failed += 1
  console.log(`  ✘ 结构：${error.message}`)
}

/* ------------------------------------------------------------------ *
 * 点击 → 立刻进入「检测中」
 * ------------------------------------------------------------------ */

try {
  // 点击必须真的触发请求，但**不能**把已有结论冲成「检测中」
  const env = boot(cases[0].payload)
  env.mod.exports.__internals.adoptUi(defaults)
  await env.mod.exports.__internals.call('/i18n')

  const settled = await render(env)
  assert.equal(typeof settled.props.onClick, 'function', '必须可点击')
  assert.equal(settled.props['data-tone'], 'on', '点击前应有结论')

  settled.props.onClick({ stopPropagation() {} })

  env.resetCursor()
  const afterClick = env.mod.exports.__internals.IpIndicator({})
  const text = textOf(afterClick).join(' ')

  assert.ok(
    text.includes(strings.zh.indicator.masked),
    `点击后结论必须保留，实际：${text}`,
  )
  assert.equal(afterClick.props['data-refreshing'], '1', '点击后应标记后台刷新')
  console.log('  ✔ 点击触发重测，但结论不被冲掉')
} catch (error) {
  failed += 1
  console.log(`  ✘ 点击行为：${error.message}`)
}

try {
  // 检测中的圆点要有呼吸动画
  const env = boot(cases[0].payload)
  env.mod.exports.__internals.adoptUi(defaults)
  const css = env.mod.exports.__internals.buildCss()
  assert.ok(css.includes('@keyframes dskg-pulse'), '检测中必须有呼吸动画')
  assert.ok(
    css.includes('.dsip-dot[data-tone="checking"]'),
    '检测中圆点必须有独立样式',
  )
  assert.ok(
    /prefers-reduced-motion[\s\S]*?dskg-pulse|dskg-pulse[\s\S]*?prefers-reduced-motion/.test(css)
      || css.includes('animation:none'),
    '必须尊重「减少动效」偏好',
  )
  console.log('  ✔ 检测中有呼吸动画且尊重减弱动效')
} catch (error) {
  failed += 1
  console.log(`  ✘ 检测中动画：${error.message}`)
}

/* ------------------------------------------------------------------ *
 * 结论常显：后台刷新不得抢走文案
 * ------------------------------------------------------------------ */

try {
  const env = boot(cases[0].payload)
  env.mod.exports.__internals.adoptUi(defaults)
  await env.mod.exports.__internals.call('/i18n')

  const settled = await render(env)
  assert.equal(settled.props['data-tone'], 'on', '首次渲染应拿到 masked 结论')
  const settledText = textOf(settled).join(' ')
  assert.ok(settledText.includes(strings.zh.indicator.masked), '应显示「已隐藏」')

  // 模拟后台轮询开始：busy 变 true，但**不能**改文案
  settled.props.onClick({ stopPropagation() {} })
  env.resetCursor()
  const refreshing = env.mod.exports.__internals.IpIndicator({})

  const refreshingText = textOf(refreshing).join(' ')
  assert.ok(
    refreshingText.includes(strings.zh.indicator.masked),
    `后台刷新时仍必须显示结论「${strings.zh.indicator.masked}」，实际：${refreshingText}`,
  )
  assert.ok(
    !refreshingText.includes(strings.zh.indicator.checking),
    '后台刷新时不得显示「检测中」',
  )
  assert.equal(refreshing.props['data-checking'], '0', '有结论时 data-checking 必须是 0')
  assert.equal(refreshing.props['data-refreshing'], '1', '后台刷新用 data-refreshing 标记')
  assert.ok(
    refreshing.props.title.includes(strings.zh.indicator.refreshing),
    '「正在刷新」只能出现在悬停提示里',
  )
  console.log('  ✔ 后台刷新不抢文案：结论常显，「检测中」只在 title 里')
} catch (error) {
  failed += 1
  console.log(`  ✘ 结论常显：${error.message}`)
}

try {
  // 从未拿到结论时，才允许显示「检测中」
  //
  // 注意：必须**全新 boot**，不能复用上一个用例的 env ——
  // 桩里的 useState 存储是 per-env 的，复用会带上上一轮已落地的结论。
  const env = boot(cases[0].payload)
  env.mod.exports.__internals.adoptUi(defaults)

  // 先把文案表灌进去（否则 t() 回落到键名），但**不跑 effect** ——
  // 这样 data 仍是 null，正是「首屏还没有结论」那一刻。
  await env.mod.exports.__internals.loadDictionary()
  await new Promise(r => setTimeout(r, 40))

  env.resetCursor()
  const first = env.mod.exports.__internals.IpIndicator({})
  assert.equal(first.props['data-checking'], '1', '首屏无结论时应标记检测中')
  const text = textOf(first).join(' ')
  assert.ok(text.includes(strings.zh.indicator.checking), `首屏应显示「检测中」，实际：${text}`)
  console.log('  ✔ 首屏无结论时才显示「检测中」')
} catch (error) {
  failed += 1
  console.log(`  ✘ 首屏检测中：${error.message}`)
}

try {
  // 后台刷新用轻脉动，不动文字颜色
  const env = boot(cases[0].payload)
  env.mod.exports.__internals.adoptUi(defaults)
  const css = env.mod.exports.__internals.buildCss()
  assert.ok(css.includes('@keyframes dskg-breathe'), '后台刷新应有轻脉动动画')
  assert.ok(
    css.includes('.dsip[data-refreshing="1"] .dsip-dot'),
    '脉动只作用于圆点',
  )
  assert.ok(
    !/\.dsip\[data-refreshing="1"\][^{]*\.dsip-value/.test(css),
    '后台刷新不得改文字颜色',
  )
  console.log('  ✔ 后台刷新只脉动圆点，不动文字')
} catch (error) {
  failed += 1
  console.log(`  ✘ 后台刷新视觉：${error.message}`)
}

/* ------------------------------------------------------------------ *
 * 视觉规格：与「AI 控制电脑」逐项对齐
 * ------------------------------------------------------------------ */

const css = (() => {
  const env = boot(cases[0].payload)
  env.mod.exports.__internals.adoptUi(defaults)
  return env.mod.exports.__internals.buildCss()
})()

const specs = {
  '28px 高（与 composer 选择器同高）': 'height:28px',
  '6px 圆点': 'width:6px;height:6px;border-radius:999px',
  '6px 间距': 'gap:6px',
  '13px / 500 字重': 'font-size:13px;font-weight:500',
  '20px 行高': 'line-height:20px',
  '3px 同色光晕': '0 0 0 3px color-mix',
  '无边框无底色（状态全靠圆点）': 'border:none;border-radius:var(--dsw-radius-sm,8px);background-color:transparent',
  '按下半像素位移': 'translateY(.5px)',
  '焦点环': 'outline:2px solid color-mix',
  '减弱动效': 'prefers-reduced-motion',
  '窄屏收起标签': '.dsip-label{display:none}',
}

for (const [name, needle] of Object.entries(specs)) {
  if (css.includes(needle)) {
    console.log(`  ✔ ${name}`)
  } else {
    failed += 1
    console.log(`  ✘ ${name}`)
  }
}

console.log(`\n${index + 1 + Object.keys(specs).length - failed}/${index + 1 + Object.keys(specs).length} 通过`)
process.exit(failed === 0 ? 0 : 1)
