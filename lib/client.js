/**
 * dsh-clash-guard —— 浏览器半。
 *
 * 形态：closure-factory 产物，由 dsh 的 `__ModuleLoader__` 加载。
 * 实现：React + `React.createElement`（不用 JSX ⇒ 零构建链）。
 *
 * **入口是侧边栏一级面板** —— 与官方「插件」「自动化任务」「Skill·MCP」
 * 「Agent 指令」同一套机制：
 *   - `sidebar.panellist` 出导航行（图标 + 文案，shell 拥有按钮本体）；
 *   - `main` 是 **keyed** 槽位，`key` 必须与导航行 id 相同
 *     （`selectPanel(id)` → layout 按 `activePanelId` 渲染）。
 *
 * 磨砂玻璃配方与 `dsh-sunfragment-skin` 逐字对齐：
 *   - 单一来源：`--dskg-frost` 先读官方令牌 `--dsw-menu-backdrop-filter`，
 *     皮肤装了就跟皮肤走，缺失时用同一份兜底值；
 *   - 磨砂 = `background: transparent` + `backdrop-filter`，两者必须同时在场；
 *   - 令牌声明在 `:root, body` 两处 —— 官方把令牌值以 inline style 写在
 *     `document.body` 上，只写 `:root` 的 var() 读不到 body 上的值；
 *   - 输入框边框用 `border-l3`：皮肤把 `bg-layer-*` 清成透明，
 *     `l1`(.24) 在 0.67px 渲染宽度下实测几乎看不见。
 *
 * 失败策略：任何一段出问题都只降级本面板，绝不影响 dsh 界面本身。
 */
window.__ModuleLoader__.load({
  id: 'dsh-clash-guard',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect
    var useCallback = React.useCallback

    var PACKAGE_ID = 'dsh-clash-guard'
    var STYLE_ID = PACKAGE_ID + '-style'

    /**
     * 运行时配置：槽位名、条目 id、排序、轮询间隔、节点上限、API 前缀、
     * 磨砂配方全部由宿主通过 `/state` 的 `settings` 下发。
     *
     * **零硬编码**：下面的初始值只在宿主应答前临时顶一下——那时面板本来也不渲染。
     */
    var UI = {
      panelId: '',
      panelSlot: '',
      panelOrder: 0,
      panelLabelZh: '',
      panelLabelEn: '',
      enablePill: false,
      pillSlot: '',
      pillId: '',
      pillOrder: 0,
      enableIndicator: false,
      indicatorSlot: '',
      indicatorId: '',
      indicatorOrder: 0,
      indicatorPollMs: 30000,
      indicatorProbeOnMount: true,
      settingsSlot: '',
      settingsId: '',
      settingsOrder: 0,
      nodeListLimit: 60,
      nodeListMaxLimit: 400,
      statePollMs: 15000,
      localeRoute: 'i18n',
      retryDelayMs: 400,
      maxAttempts: 8,
      maxContentWidth: 960,
      httpPrefix: '',
      glassToken: '--dsw-menu-backdrop-filter',
      glassFallback: '',
    }

    /**
     * 把宿主下发的 ui / http / glass 段合并进来。
     * @param {object} settings 宿主 /state 的 settings 字段
     * @returns {boolean} 是否采纳成功
     */
    function adoptUi(settings) {
      if (!settings) return false
      var ui = settings.ui
      if (ui) {
        if (typeof ui.panelId === 'string' && ui.panelId !== '') UI.panelId = ui.panelId
        if (typeof ui.panelSlot === 'string' && ui.panelSlot !== '') UI.panelSlot = ui.panelSlot
        if (typeof ui.panelOrder === 'number') UI.panelOrder = ui.panelOrder
        if (typeof ui.panelLabelZh === 'string' && ui.panelLabelZh !== '') UI.panelLabelZh = ui.panelLabelZh
        if (typeof ui.panelLabelEn === 'string' && ui.panelLabelEn !== '') UI.panelLabelEn = ui.panelLabelEn
        if (typeof ui.enablePill === 'boolean') UI.enablePill = ui.enablePill
        if (typeof ui.pillSlot === 'string') UI.pillSlot = ui.pillSlot
        if (typeof ui.pillId === 'string') UI.pillId = ui.pillId
        if (typeof ui.pillOrder === 'number') UI.pillOrder = ui.pillOrder
        if (typeof ui.enableIndicator === 'boolean') UI.enableIndicator = ui.enableIndicator
        if (typeof ui.indicatorSlot === 'string' && ui.indicatorSlot !== '') UI.indicatorSlot = ui.indicatorSlot
        if (typeof ui.indicatorId === 'string' && ui.indicatorId !== '') UI.indicatorId = ui.indicatorId
        if (typeof ui.indicatorOrder === 'number') UI.indicatorOrder = ui.indicatorOrder
        if (typeof ui.indicatorPollMs === 'number' && ui.indicatorPollMs > 0) UI.indicatorPollMs = ui.indicatorPollMs
        if (typeof ui.indicatorProbeOnMount === 'boolean') UI.indicatorProbeOnMount = ui.indicatorProbeOnMount
        if (typeof ui.settingsSlot === 'string') UI.settingsSlot = ui.settingsSlot
        if (typeof ui.settingsId === 'string') UI.settingsId = ui.settingsId
        if (typeof ui.settingsOrder === 'number') UI.settingsOrder = ui.settingsOrder
        if (typeof ui.nodeListLimit === 'number' && ui.nodeListLimit > 0) UI.nodeListLimit = ui.nodeListLimit
        if (typeof ui.nodeListMaxLimit === 'number' && ui.nodeListMaxLimit > 0) UI.nodeListMaxLimit = ui.nodeListMaxLimit
        if (typeof ui.statePollMs === 'number' && ui.statePollMs > 0) UI.statePollMs = ui.statePollMs
        if (typeof ui.localeRoute === 'string' && ui.localeRoute !== '') UI.localeRoute = ui.localeRoute
        if (typeof ui.retryDelayMs === 'number' && ui.retryDelayMs > 0) UI.retryDelayMs = ui.retryDelayMs
        if (typeof ui.maxAttempts === 'number' && ui.maxAttempts > 0) UI.maxAttempts = ui.maxAttempts
        if (typeof ui.maxContentWidth === 'number' && ui.maxContentWidth > 0) UI.maxContentWidth = ui.maxContentWidth
      }
      if (settings.http && typeof settings.http.prefix === 'string' && settings.http.prefix !== '') {
        UI.httpPrefix = settings.http.prefix
      }
      if (settings.glass) {
        if (typeof settings.glass.token === 'string' && settings.glass.token !== '') UI.glassToken = settings.glass.token
        if (typeof settings.glass.fallback === 'string' && settings.glass.fallback !== '') {
          UI.glassFallback = settings.glass.fallback
        }
      }
      return true
    }

    /**
     * API 基址。
     *
     * **引导前缀**：`/` + 模块 id。这不是硬编码 —— 它是从 package.json 的
     * `name`（也就是 `__ModuleLoader__.load({ id })` 的那个 id）派生的，
     * 与宿主路由前缀的约定同源。宿主的 `settings.http.prefix` 到达后会覆盖它。
     *
     * 为什么需要引导：`/state` 的应答里才带着 `http.prefix`，而没有前缀就
     * 发不出第一次 `/state` 请求 —— 直接返回空会让整个插件永远挂不上。
     */
    function apiBase() {
      return UI.httpPrefix !== '' ? UI.httpPrefix : '/' + PACKAGE_ID
    }

    /** 文档语言 → 'zh' | 'en'。 */
    function documentLang() {
      try {
        var lang = String(document.documentElement.lang || '').toLowerCase()
        return lang.indexOf('en') === 0 ? 'en' : 'zh'
      } catch (error) {
        return 'zh'
      }
    }

    /* ------------------------------------------------------------------ *
     * 样式：磨砂玻璃，配方与 dsh-sunfragment-skin 逐字对齐
     * ------------------------------------------------------------------ */

    /**
     * 生成样式表。磨砂力度与兜底值来自宿主下发的 defaults.glass，
     * 令牌链是 `--dskg-frost: var(--dsw-menu-backdrop-filter, <fallback>)`。
     * @returns {string}
     */
    function buildCss() {
      var token = UI.glassToken
      var fallback = UI.glassFallback
      var maxW = UI.maxContentWidth
      var frost = 'var(--dskg-frost)'

      return [
        /* —— 磨砂令牌：声明在 :root 与 body 两处 ——
           官方主题把令牌值作为 inline style 写在 document.body 上，
           写在 :root(html) 上的 var() 看不到 body 上的值，于是永远落兜底值。
           body 让皮肤的值真正生效；:root 兜住 body 出现之前的窗口，
           也覆盖 Modal portal 到 body 的情形。 */
        ':root,',
        'body {',
        '  --dskg-frost: var(' + token + ', ' + fallback + ');',
        /* —— 语义色：**不假设官方 primary/secondary 成对可用** ——
           实测踩坑：dsh-sunfragment-skin 把
             --dsw-alias-state-warn-primary    → violet #c97cf3
             --dsw-alias-state-warn-secondary  → violet #c97cf3（同一个值！）
           于是「warn 色文字 + warn 色背景」= 紫字压紫底，完全隐形。

           更要命的是**语义也错了**：警告不该是紫色。紫色在这套皮肤里
           是「交互高亮」的语言，拿它表示「注意风险」会让用户以为是个可点的东西。

           所以这里自己定一套三档语义色。**关键是前景色必须够亮**：
           官方的 error #bf3636 在深底上只有 3.34:1，不达 WCAG AA 的 4.5:1，
           所以前景用提亮过的红，背景仍可用原色（半透明压深底足够）。 */
        '  --dskg-tone-safe-fg: var(--dsw-alias-state-success-primary, #2eff62);',
        '  --dskg-tone-safe-bg: color-mix(in srgb, var(--dsw-alias-state-success-primary, #059669) 26%, transparent);',
        '  --dskg-tone-warn-fg: var(--dskg-amber, #f5a524);',
        '  --dskg-tone-warn-bg: color-mix(in srgb, var(--dskg-amber, #f5a524) 26%, transparent);',
        /* 提亮红：在 #10141b 上约 5.6:1，达 AA */
        '  --dskg-tone-bad-fg: var(--dskg-red, #ff6b6b);',
        '  --dskg-tone-bad-bg: color-mix(in srgb, var(--dskg-red, #ff6b6b) 26%, transparent);',
        /* 琥珀与提亮红：不依赖任何主题令牌，保证深/浅底都读得清 */
        '  --dskg-amber: #f5a524;',
        '  --dskg-red: #ff6b6b;',
        /* 行悬停：皮肤把 --dsw-alias-interactive-bg-hover 映射成 violetTint（紫），
           在清单里出现一条紫横条非常突兀。改用「当前文字色 + 极低透明度」，
           任何主题下都是克制的浅高亮。 */
        '  --dskg-row-hover: color-mix(in srgb, var(--dsw-alias-label-primary, #fff) 8%, transparent);',
        '  --dskg-hover: color-mix(in srgb, var(--dsw-alias-label-primary, #fff) 10%, transparent);',
        '}',
        /* —— 页面骨架：占满真实主列，不猜侧边栏宽度 —— */
        /* translate=no：Chrome 页面翻译会把「Clash」翻成「冲突」、把
           fake-ip 等术语重排，整个面板意思全歪。根容器整块标记不翻译。 */
        '.dskg, .dsip { translate: no; }',
        '.dskg {',
        '  display: flex;',
        '  flex-direction: column;',
        '  gap: 16px;',
        '  box-sizing: border-box;',
        '  width: 100%;',
        '  max-width: ' + maxW + 'px;',
        '  min-width: 0;',
        '  margin: 0 auto;',
        '  padding: calc(28px + var(--dsh-frame-top-clearance, 0px)) clamp(24px, 4vw, 48px) 48px;',
        '  height: 100%;',
        '  min-height: 0;',
        '  overflow-y: auto;',
        '  overflow-x: hidden;',
        '  color: var(--dsw-alias-label-primary);',
        '}',
        '.dskg-head { display: flex; flex-direction: column; gap: 6px; }',
        '.dskg-title { margin: 0; font-size: 20px; font-weight: 500; }',
        /* 错误横幅：把 setError 的内容真正显示出来。
           之前 err 状态被写入 12 处却从未渲染 —— 所有错误静默丢失。 */
        '.dskg-error {',
        '  display: flex;',
        '  align-items: flex-start;',
        '  gap: 10px;',
        '  margin: 0 0 14px;',
        '  padding: 10px 14px;',
        '  border-radius: 10px;',
        '  background: var(--dskg-tone-bad-bg);',
        '  border: 1px solid color-mix(in srgb, var(--dskg-tone-bad-fg) 34%, transparent);',
        '  color: var(--dskg-tone-bad-fg);',
        '  font-size: 13px;',
        '  line-height: 1.5;',
        '}',
        '.dskg-error-mark {',
        '  flex: none;',
        '  width: 16px; height: 16px;',
        '  border-radius: 999px;',
        '  background: var(--dskg-tone-bad-fg);',
        '  color: var(--dskg-bg, #0b0d10);',
        '  font-size: 11px; font-weight: 700;',
        '  display: inline-flex; align-items: center; justify-content: center;',
        '  margin-top: 1px;',
        '}',
        '.dskg-error-text { flex: 1; word-break: break-word; }',
        '.dskg-error-close {',
        '  flex: none;',
        '  border: none; background: transparent;',
        '  color: inherit; opacity: .7;',
        '  font-size: 16px; line-height: 1;',
        '  cursor: pointer; padding: 0 2px;',
        '}',
        '.dskg-error-close:hover { opacity: 1; }',
        '.dskg-sub { margin: 0; color: var(--dsw-alias-label-secondary); font-size: 13px; line-height: 1.6; }',

        /* —— 卡片：零自选色，实感全部来自薄磨砂 —— */
        '.dskg-card {',
        '  background: var(--dsw-alias-bg-layer-1);',
        '  -webkit-backdrop-filter: ' + frost + ';',
        '  backdrop-filter: ' + frost + ';',
        '  border: 1px solid var(--dsw-alias-border-l1);',
        '  border-radius: 16px;',
        '  padding: 12px 16px;',
        '}',
        '.dskg-card + .dskg-card { margin-top: 12px; }',
        '.dskg-section-title {',
        '  margin: 4px 0 8px;',
        '  font-size: 12px;',
        '  font-weight: 600;',
        '  color: var(--dsw-alias-label-tertiary);',
        '  text-transform: uppercase;',
        '  letter-spacing: 0.04em;',
        '}',
        '.dskg-note { margin: 0 0 12px; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.6; }',

        /* —— 三段式分段控件 —— */
        '.dskg-seg { display: inline-flex; gap: 6px; flex-wrap: wrap; align-self: flex-start; }',
        '.dskg-seg button {',
        '  box-sizing: border-box;',
        '  cursor: pointer;',
        '  padding: 8px 20px;',
        '  border-radius: 10px;',
        '  border: 1px solid var(--dsw-alias-border-l3);',
        '  font: inherit;',
        '  font-size: 13px;',
        '  color: var(--dsw-alias-label-primary);',
        '  background: transparent;',
        '  -webkit-backdrop-filter: ' + frost + ';',
        '  backdrop-filter: ' + frost + ';',
        '  transition: background .12s ease, border-color .12s ease;',
        '}',
        '.dskg-seg button:hover:not(:disabled) { background: var(--dskg-hover); }',
        '.dskg-seg button:focus-visible { outline: 2px solid var(--dsw-focus-ring-color); outline-offset: 1px; }',
        /* 选中态文字用**深色**：亮绿/琥珀/红实底上白字对比度不够，
           尤其绿 #2eff62 亮度很高，白字几乎糊在一起。
           深色文字在三档实底上都清晰。 */
        '.dskg-seg button[data-on="1"] {',
        '  border-color: transparent;',
        '  color: var(--dsw-alias-label-primary-foreground, #0b0d10);',
        '  font-weight: 600;',
        '}',
        '.dskg-seg button[data-on="1"][data-mode="global"] { background: var(--dskg-tone-safe-fg); }',
        '.dskg-seg button[data-on="1"][data-mode="rule"] { background: var(--dskg-tone-warn-fg); }',
        '.dskg-seg button[data-on="1"][data-mode="off"] { background: var(--dskg-tone-bad-fg); }',
        /* 「关闭」是红实底，深色文字在 #bf3636 上偏暗 —— 用白字更稳 */
        '.dskg-seg button[data-on="1"][data-mode="off"] { color: #fff; }',
        '.dskg-seg button:disabled { opacity: .6; cursor: progress; }',

        /* —— 裁决胶囊 ——
           背景/文字走自定义语义色（--dskg-tone-*），不吃官方 primary/secondary，
           因为皮肤会把这两个令牌映射成同一个紫色，那样字和底同色 = 隐形。
           注意：**文字色必须跟着档位一起变**，只改背景会出现「红底琥珀字」。 */
        '.dskg-verdict {',
        '  display: inline-flex;',
        '  align-items: center;',
        '  gap: 8px;',
        '  padding: 5px 14px;',
        '  border-radius: 999px;',
        '  font-weight: 600;',
        '  font-size: 12px;',
        '  -webkit-backdrop-filter: ' + frost + ';',
        '  backdrop-filter: ' + frost + ';',
        '  color: var(--dskg-tone-warn-fg);',
        '  background: var(--dskg-tone-warn-bg);',
        '  border: 1px solid color-mix(in srgb, currentColor 22%, transparent);',
        '}',
        '.dskg-verdict[data-v="safe"] {',
        '  color: var(--dskg-tone-safe-fg);',
        '  background: var(--dskg-tone-safe-bg);',
        '}',
        '.dskg-verdict[data-v="leaking"] {',
        '  color: var(--dskg-tone-bad-fg);',
        '  background: var(--dskg-tone-bad-bg);',
        '}',
        '.dskg-verdict[data-v="unprotected"] {',
        '  color: var(--dskg-tone-warn-fg);',
        '  background: var(--dskg-tone-warn-bg);',
        '}',

        /* —— 审计清单：行是玻璃行，悬停走官方交互令牌 —— */
        /* —— 审计清单：行悬停用克制的浅高亮，不用皮肤的紫色悬停 —— */
        '.dskg-checks { display: flex; flex-direction: column; gap: 1px; margin-top: 10px; }',
        '.dskg-check {',
        '  display: grid;',
        '  grid-template-columns: 18px 1fr auto;',
        '  gap: 10px;',
        '  align-items: start;',
        '  padding: 8px 10px;',
        '  border-radius: 8px;',
        '  box-sizing: border-box;',
        '  transition: background-color .12s ease;',
        '}',
        '.dskg-check:hover { background: var(--dskg-row-hover); }',
        '.dskg-mark { font-size: 13px; line-height: 1.5; flex: 0 0 auto; }',
        '.dskg-check[data-ok="1"] .dskg-mark { color: var(--dskg-tone-safe-fg); }',
        '.dskg-check[data-ok="0"] .dskg-mark { color: var(--dskg-tone-bad-fg); }',
        '.dskg-t { font-weight: 500; font-size: 13px; }',
        '.dskg-d { color: var(--dsw-alias-label-secondary); font-size: 12px; word-break: break-word; line-height: 1.55; }',
        /* 严重度徽标：中文化后是「严重/高/中/低」，只出现在失败项上 */
        '.dskg-s {',
        '  font-size: 11px;',
        '  white-space: nowrap;',
        '  padding: 1px 8px;',
        '  border-radius: 999px;',
        '  align-self: start;',
        '  color: var(--dskg-tone-bad-fg);',
        '  background: var(--dskg-tone-bad-bg);',
        '}',
        /* 高危项加强：左侧细条，扫视时先看到它们 */
        '.dskg-check[data-ok="0"][data-sev="critical"] {',
        '  box-shadow: inset 2px 0 0 var(--dskg-tone-bad-fg);',
        '}',

        /* —— 按钮 —— */
        '.dskg-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }',
        '.dskg-btn {',
        '  box-sizing: border-box;',
        '  cursor: pointer;',
        '  padding: 7px 14px;',
        '  border-radius: 8px;',
        '  border: 1px solid var(--dsw-alias-border-l3);',
        '  font: inherit;',
        '  font-size: 12px;',
        '  color: var(--dsw-alias-label-primary);',
        '  background: transparent;',
        '  -webkit-backdrop-filter: ' + frost + ';',
        '  backdrop-filter: ' + frost + ';',
        '}',
        '.dskg-btn:hover:not(:disabled) { background: var(--dskg-hover); }',
        '.dskg-btn:focus-visible { outline: 2px solid var(--dsw-focus-ring-color); outline-offset: 1px; }',
        '.dskg-btn[data-primary="1"] {',
        '  background: var(--dsw-alias-brand-primary);',
        '  color: var(--dsw-alias-label-primary-foreground, #fff);',
        '  border-color: transparent;',
        '  font-weight: 600;',
        '}',
        '.dskg-btn:disabled { opacity: .5; cursor: not-allowed; }',

        /* —— 键值对 —— */
        '.dskg-kv { display: grid; grid-template-columns: auto 1fr; gap: 5px 18px; font-size: 12px; margin: 12px 0 0; }',
        '.dskg-kv dt { color: var(--dsw-alias-label-tertiary); white-space: nowrap; }',
        '.dskg-kv dd { margin: 0; font-variant-numeric: tabular-nums; word-break: break-word; }',

        /* —— 节点列表：自滚动，行是玻璃行 —— */
        '.dskg-nodes {',
        '  display: flex;',
        '  flex-direction: column;',
        '  gap: 1px;',
        '  max-height: min(340px, 42vh);',
        '  overflow-y: auto;',
        '  overscroll-behavior: contain;',
        '  scrollbar-gutter: stable;',
        '  margin-top: 10px;',
        '  padding-right: 4px;',
        '}',
        '.dskg-node {',
        '  display: grid;',
        '  grid-template-columns: 1fr auto auto;',
        '  gap: 10px;',
        '  align-items: center;',
        '  padding: 7px 10px;',
        '  border-radius: 8px;',
        '  border: none;',
        '  background: transparent;',
        '  color: inherit;',
        '  font: inherit;',
        '  font-size: 12px;',
        '  text-align: left;',
        '  cursor: pointer;',
        '  box-sizing: border-box;',
        '  width: 100%;',
        '}',
        '.dskg-node:hover { background: var(--dskg-hover); }',
        '.dskg-node:focus-visible { outline: 2px solid var(--dsw-focus-ring-color); outline-offset: -2px; }',
        /* 当前节点：左侧亮条 + 轻底。
           不用 interactive-bg-active —— 皮肤把它映射成紫色，与「安全」语义冲突。 */
        '.dskg-node[data-on="1"] {',
        '  background: color-mix(in srgb, var(--dsw-alias-brand-primary, #2eff62) 14%, transparent);',
        '  box-shadow: inset 2px 0 0 var(--dsw-alias-brand-primary);',
        '  font-weight: 600;',
        '}',
        '.dskg-nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
        '.dskg-ty { color: var(--dsw-alias-label-tertiary); font-size: 11px; white-space: nowrap; }',
        '.dskg-lat { color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; white-space: nowrap; }',
        /* 延迟分级：<150 绿、<400 正常、<1000 琥珀、其余红。
           一列数字看不出好坏，颜色一眼能扫。 */
        '.dskg-lat[data-tier="fast"] { color: var(--dskg-tone-safe-fg); }',
        '.dskg-lat[data-tier="slow"] { color: var(--dskg-tone-warn-fg); }',
        '.dskg-lat[data-tier="dead"] { color: var(--dskg-tone-bad-fg); }',

        /* —— 开关行 —— */
        '.dskg-toggle { display: flex; align-items: center; gap: 10px; font-size: 12px; padding: 6px 2px; cursor: pointer; box-sizing: border-box; }',
        '.dskg-toggle input { accent-color: var(--dsw-alias-brand-primary); flex: 0 0 auto; }',
        '.dskg-toggle span { color: var(--dsw-alias-label-secondary); }',

        /* —— 错误与提示 —— */
        '.dskg-err {',
        '  margin-top: 8px;',
        '  padding: 8px 12px;',
        '  border-radius: 8px;',
        '  background: var(--dsw-alias-state-error-secondary);',
        '  color: var(--dsw-alias-label-primary);',
        '  font-size: 12px;',
        '  -webkit-backdrop-filter: ' + frost + ';',
        '  backdrop-filter: ' + frost + ';',
        '}',
        '.dskg-hint { font-size: 11px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }',
        '.dskg-empty {',
        '  padding: 28px 16px;',
        '  text-align: center;',
        '  color: var(--dsw-alias-label-tertiary);',
        '  font-size: 13px;',
        '}',
        '@media (max-width: 720px) {',
        '  .dskg { padding-left: 20px; padding-right: 20px; }',
        '}',

        /* —— 输入框（设置页用）：皮肤把 bg-layer-* 清成透明，
             可辨识度只能来自边框，所以用 border-l3（alpha .42）—— */
        '.dskg-input {',
        '  width: 100%;',
        '  box-sizing: border-box;',
        '  padding: 7px 10px;',
        '  border-radius: 8px;',
        '  border: 1px solid var(--dsw-alias-border-l3);',
        '  background: var(--dsw-alias-bg-layer-2);',
        '  -webkit-backdrop-filter: ' + frost + ';',
        '  backdrop-filter: ' + frost + ';',
        '  color: var(--dsw-alias-label-primary);',
        '  font: inherit;',
        '  font-size: 12px;',
        '}',
        '.dskg-input:focus { outline: 2px solid var(--dsw-focus-ring-color); outline-offset: 1px; }',
        '.dskg-input::placeholder { color: var(--dsw-alias-label-tertiary); opacity: .85; }',

        /* —— 出口 IP 指示灯 ——
           与「AI 控制电脑」逐项对齐：无边框无底色（状态全靠圆点），
           28px 高 / 13px 500 字重 / 20px 行高 / 6px 圆点 / 6px 间距，
           点亮时圆点带 3px 同色光晕。 */
        '.dsip{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 8px;',
        'border:none;border-radius:var(--dsw-radius-sm,8px);background-color:transparent;',
        'color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;font-weight:500;',
        'line-height:20px;cursor:pointer;white-space:nowrap;user-select:none;',
        'transition:background-color .1s ease,opacity .14s ease}',
        '@media (hover:hover){.dsip:hover{background-color:var(--dskg-hover)}}',
        '.dsip:active{transform:translateY(.5px)}',
        '.dsip:focus-visible{',
        'outline:2px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,transparent);',
        'outline-offset:1px}',
        '.dsip[data-busy="1"]{opacity:.65;cursor:progress}',
        '.dsip[data-checking="1"]{cursor:progress}',
        /* 只有「还没有任何结论」时才压暗文字。
           后台刷新（data-refreshing）不动文字 —— 结论必须始终可读。 */
        '.dsip[data-checking="1"] .dsip-value{color:var(--dsw-alias-label-tertiary)}',
        /* 后台刷新：圆点做很轻的脉动，提示「正在更新」，但不抢注意力。 */
        '.dsip[data-refreshing="1"] .dsip-dot{animation:dskg-breathe 1.6s ease-in-out infinite}',
        '@keyframes dskg-breathe{',
        '0%,100%{opacity:1}',
        '50%{opacity:.55}',
        '}',
        '.dsip-dot[data-tone="checking"]{',
        'background:var(--dsw-alias-state-idle-primary);',
        'animation:dskg-pulse 1.1s ease-in-out infinite}',
        '@keyframes dskg-pulse{',
        '0%,100%{opacity:.35;box-shadow:0 0 0 0 transparent}',
        '50%{opacity:1;box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-label-primary,#fff) 16%,transparent)}',
        '}',
        '.dsip-dot{width:6px;height:6px;border-radius:999px;flex:none;',
        'background:var(--dsw-alias-state-idle-primary);',
        'transition:background-color .18s ease,box-shadow .18s ease}',
        '.dsip-dot[data-tone="on"]{background:var(--dskg-tone-safe-fg);',
        'box-shadow:0 0 0 3px color-mix(in srgb,var(--dskg-tone-safe-fg) 22%,transparent)}',
        '.dsip-dot[data-tone="warn"]{background:var(--dskg-tone-warn-fg);',
        'box-shadow:0 0 0 3px color-mix(in srgb,var(--dskg-tone-warn-fg) 22%,transparent)}',
        '.dsip-dot[data-tone="off"]{background:var(--dskg-tone-bad-fg);',
        'box-shadow:0 0 0 3px color-mix(in srgb,var(--dskg-tone-bad-fg) 22%,transparent)}',
        /* 空心中点：用于「待校准」—— 还没结论，不是警告。
           实心 = 已知状态，空心 = 未知状态，一眼能分。 */
        '.dsip-dot[data-tone="unknown"]{background:transparent;',
        'box-shadow:inset 0 0 0 1.5px var(--dskg-tone-warn-fg)}',
        /* 灰点：测不到（断网/全被拦），不是风险 */
        '.dsip-dot[data-tone="idle"]{background:var(--dsw-alias-state-idle-primary);',
        'box-shadow:none;opacity:.75}',
        '.dsip-label{color:var(--dsw-alias-label-tertiary)}',
        '.dsip-value{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
        '.dsip[data-tone="on"] .dsip-value{color:var(--dskg-tone-safe-fg)}',
        '.dsip[data-tone="warn"] .dsip-value{color:var(--dskg-tone-warn-fg)}',
        '.dsip[data-tone="off"] .dsip-value{color:var(--dskg-tone-bad-fg)}',
        '.dsip[data-tone="unknown"] .dsip-value{color:var(--dskg-tone-warn-fg)}',
        '.dsip[data-tone="idle"] .dsip-value{color:var(--dsw-alias-label-tertiary)}',
        /* 三档响应式。**顺序很重要**：宽的在前，窄的在后覆盖。
           之前 1100px 就把标签藏了，而 1100px 是很常见的桌面宽度 ——
           结果只剩一个孤零零的圆点，用户不知道那是什么。
           「出口 IP」三个字是身份，比结论更该保留。 */
        /* ① 中等宽度：收起值，留标签 + 圆点 */
        '@media (max-width:1100px){.dsip-value{display:none}.dsip{gap:5px}}',
        /* ② 窄：进一步压缩内边距 */
        '@media (max-width:860px){.dsip{padding:0 5px}}',
        /* ③ 极窄：连标签也收，退回纯圆点（靠 title 与位置识别） */
        '@media (max-width:560px){.dsip-label{display:none}.dsip{padding:0 4px}}',
        '@media (prefers-reduced-motion:reduce){.dsip,.dsip-dot{transition:none}',
        '.dsip[data-refreshing="1"] .dsip-dot{animation:none;opacity:.75}',
        '.dsip-dot[data-tone="checking"]{animation:none;opacity:.7}}',
      ].join('\n')
    }

    /** 注入样式（一次性；loader 卸载时按 data-plugin 清理）。 */
    function installStyles() {
      try {
        if (typeof document === 'undefined') return
        var existing = document.querySelector('style[data-plugin="' + PACKAGE_ID + '"]')
        if (existing !== null) existing.remove()
        var tag = document.createElement('style')
        tag.dataset.plugin = PACKAGE_ID
        tag.id = STYLE_ID
        tag.textContent = buildCss()
        document.head.appendChild(tag)
      } catch (error) {
        console.warn('[dsh-clash-guard] 样式注入跳过：', error)
      }
    }

    /* ------------------------------------------------------------------ *
     * 文案
     * ------------------------------------------------------------------ */

    var dictionary = null
    var dictionaryPromise = null

    function loadDictionary() {
      if (dictionaryPromise !== null) return dictionaryPromise
      dictionaryPromise = fetch(apiBase() + '/' + UI.localeRoute, { credentials: 'same-origin' })
        .then(function (res) { return res.ok ? res.json() : null })
        .then(function (payload) {
          if (payload && payload.ok && payload.table) dictionary = payload.table
          return dictionary
        })
        .catch(function () { return null })
      return dictionaryPromise
    }

    /** 取一条文案；缺失时回落到键名，绝不显示 undefined。 */
    function t(path) {
      var lang = documentLang()
      var table = dictionary
      if (!table) return path
      var bucket = table[lang] || table.zh || table.en
      if (!bucket) return path
      var node = bucket
      var parts = path.split('.')
      for (var i = 0; i < parts.length; i += 1) {
        if (node === null || typeof node !== 'object') return path
        node = node[parts[i]]
      }
      return typeof node === 'string' ? node : path
    }

    /** 统一 API 调用。 */
    /**
     * 调后端。
     *
     * **写操作必须带 body**（哪怕是 `{}`）。原因：请求头是按
     * `body === undefined` 分流的 —— 不传 body 就只有 accept，没有
     * content-type，服务端的 `isJsonRequest` 会判 415。
     *
     * 所以这里不再靠调用方记得传 body：`method` 是 POST/PUT/PATCH 而
     * 调用方没给 body 时，自动补一个空对象。
     */
    function call(path, options) {
      var init = options || {}
      var method = String(init.method || 'GET').toUpperCase()
      var needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH'
      var body = init.body
      if (needsBody && body === undefined) body = {}
      return fetch(apiBase() + path, {
        method: method,
        credentials: 'same-origin',
        headers: body === undefined
          ? { accept: 'application/json' }
          : { accept: 'application/json', 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
        .then(function (res) { return res.ok ? res.json() : null })
        .catch(function () { return null })
    }

    /* ------------------------------------------------------------------ *
     * 图标（官方 sidebar.panellist 约定：组件收到 { size, active }）
     * ------------------------------------------------------------------ */

    /** 盾牌图标：自绘 SVG，与插件 icon.svg 同源。 */
    function ShieldIcon(props) {
      var size = (props && props.size) || 16
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
        focusable: 'false',
      },
      h('path', { d: 'M12 2.6 4.2 5.6v6.1c0 4.5 3.3 8.2 7.8 9.7 4.5-1.5 7.8-5.2 7.8-9.7V5.6L12 2.6Z' }),
      h('circle', { cx: 12, cy: 10.4, r: 2.3 }),
      h('path', { d: 'M12 12.7v3.9' }),
      h('path', { d: 'M7.6 20.4h8.8' }))
    }

    /* ------------------------------------------------------------------ *
     * 主面板
     * ------------------------------------------------------------------ */

    var MODE_KEYS = ['global', 'rule', 'off']

    function modeLabel(mode) {
      if (mode === 'global') return t('pill.modeGlobal')
      if (mode === 'rule') return t('pill.modeRule')
      if (mode === 'off') return t('pill.modeOff')
      return mode
    }

    function modeHint(mode) {
      if (mode === 'global') return t('pill.hintGlobal')
      if (mode === 'rule') return t('pill.hintRule')
      return t('pill.hintOff')
    }

    function Card(props) {
      return h('div', { className: 'dskg-card' },
        props.title ? h('div', { className: 'dskg-section-title' }, props.title) : null,
        props.note ? h('p', { className: 'dskg-note' }, props.note) : null,
        props.children)
    }

    /**
     * 一条审计结果。
     *
     * **严重度只在失败时显示**。通过项挂着「严重」徽标会让用户以为出了问题 ——
     * 严重度描述的是「这条一旦失败有多要紧」，不是「当前有多要紧」。
     * 通过项留空，视觉噪音减半，红点也更突出。
     */
    function CheckRow(props) {
      var check = props.check
      var severity = SEVERITY_LABEL[check.severity] || check.severity
      return h('div', { className: 'dskg-check', 'data-ok': check.ok ? '1' : '0', 'data-sev': check.severity },
        h('span', { className: 'dskg-mark', 'aria-hidden': 'true' }, check.ok ? '✔' : '✘'),
        h('div', null,
          h('div', { className: 'dskg-t' }, check.title),
          h('div', { className: 'dskg-d' }, check.detail)),
        check.ok ? null : h('span', { className: 'dskg-s', title: t('page.severityHint') }, severity))
    }

    function GuardPanel() {
      var statePair = useState(null)
      var state = statePair[0]
      var setState = statePair[1]
      var auditPair = useState(null)
      var audit = auditPair[0]
      var setAudit = auditPair[1]
      var nodesPair = useState(null)
      var nodes = nodesPair[0]
      var setNodes = nodesPair[1]
      var nodesRef = { current: null }
      var setNodesRef = function (v) { nodesRef.current = v }
      var busyPair = useState('')
      var busy = busyPair[0]
      var setBusy = busyPair[1]
      var errPair = useState('')
      var error = errPair[0]
      var setError = errPair[1]
      var settingsPair = useState(null)
      var settings = settingsPair[0]
      var setSettings = settingsPair[1]
      var savedPair = useState('')
      var netHealPair = useState('')
      var netHeal = netHealPair[0]
      var setNetHeal = netHealPair[1]
      var saved = savedPair[0]
      var setSaved = savedPair[1]
      var kernelPair = useState(null)
      var kernel = kernelPair[0]
      var setKernel = kernelPair[1]

      var refresh = useCallback(function () {
        return call('/state').then(function (payload) {
          if (payload === null) {
            setError(t('page.errState'))
            setState({ reachable: false, error: t('page.errState') })
            return
          }
          setState(payload)
          if (payload.settings) setSettings(payload.settings)
        })
      }, [])

      // nodesRef 供 onLatency 读最新列表（state 闭包会过期）
      useEffect(function () { nodesRef.current = nodes }, [nodes])

      useEffect(function () {
        loadDictionary().then(refresh)
        // 内核状态与 /state 分开读：即使控制器不可达，也要能看见内核在不在
        call('/kernel').then(function (payload) {
          if (payload !== null && payload.ok === true) setKernel(payload.state)
        })
        // **首屏就把节点列表拉下来**。
        // 之前只读 /state 与 /kernel，节点卡片一直是空的 ——
        // 用户得先点一次「刷新」才看得到节点，那是白白多一步。
        call('/nodes?limit=' + UI.nodeListLimit).then(function (payload) {
          if (payload !== null) setNodes(payload)
        })
      }, [refresh])

      var onKernel = useCallback(function (action) {
        setBusy('kernel:' + action)
        setError('')
        call('/kernel', { method: 'POST', body: { action: action } }).then(function (payload) {
          if (payload === null) { setError(t('page.errKernel')); return }
          if (payload.ok !== true) setError(payload.detail || payload.error || 'kernel action failed')
          if (payload.state) setKernel(payload.state)
          return refresh()
        }).finally(function () { setBusy('') })
      }, [refresh])

      var current = state && state.reachable ? state.modeName : ''

      var onMode = useCallback(function (mode) {
        if (busy !== '') return
        setBusy('mode')
        setError('')
        call('/mode', { method: 'POST', body: { mode: mode } })
          .then(function (payload) {
            if (payload === null) { setError(t('page.errRequest')); return }
            if (payload.ok !== true) setError(payload.error || t('page.errSwitch'))
            return refresh()
          })
          .finally(function () { setBusy('') })
      }, [busy, refresh])

      var onAudit = useCallback(function () {
        setBusy('audit')
        setError('')
        call('/verify', { method: 'POST' })
          .then(function (payload) {
            if (payload === null) { setError(t('page.errAudit')); return }
            if (payload.ok !== true) { setError(payload.error || t('page.errAudit')); return }
            setAudit(payload)
          })
          .finally(function () { setBusy('') })
      }, [])

      var onNodes = useCallback(function () {
        if (busy !== '') return
        setBusy('nodes')
        setError('')
        call('/nodes?limit=' + UI.nodeListLimit).then(function (payload) {
          // 失败要有反馈：静默失败会让用户以为按钮坏了
          if (payload === null) { setError(t('page.errRequest')); return }
          if (payload.ok !== true && payload.error) { setError(payload.error); return }
          setNodes(payload)
        }).finally(function () { setBusy('') })
      }, [busy])

      /**
       * 一键全组测速（借鉴 metacubexd / zashboard 的核心交互）。
       *
       * GET /latency 并发测全组（2.5s），返回按延迟排序的排行。
       * 用排行重渲染节点列表 —— 列表从「字典序」变成「延迟序」，
       * 最快的节点排最前，用户一眼看到可用节点。
       */
      var onLatency = useCallback(function () {
        if (busy !== '') return
        setBusy('latency')
        setError('')
        call('/latency').then(function (payload) {
          if (payload === null) { setError(t('page.errRequest')); return }
          if (payload.ok !== true) { setError(payload.error || t('page.errRequest')); return }
          var list = payload.entries ?? []
          if (nodesRef.current !== null && nodesRef.current.group) {
            // 保留组名，重排节点（延迟来自本次测速；没测到的排后面）
            var rank = {}
            for (var i = 0; i < list.length; i++) rank[list[i].name] = list[i].delay
            var reordered = (nodesRef.current.nodes ?? []).slice().sort(function (a, b) {
              var da = rank[a.name], db = rank[b.name]
              if (da === undefined && db === undefined) return 0
              if (da === undefined) return 1
              if (db === undefined) return -1
              return da - db
            }).map(function (n) {
              return rank[n.name] !== undefined ? Object.assign({}, n, { delay: rank[n.name], alive: true }) : n
            })
            setNodes(Object.assign({}, nodesRef.current, { nodes: reordered }))
          }
        }).finally(function () { setBusy('') })
      }, [busy])

      /**
       * 切节点。
       *
       * **必须是 POST**：它改变了服务端状态（把 GLOBAL 指到某个节点），
       * 用 GET + query 是语义错误 —— 浏览器/代理可能缓存或预取那个 URL，
       * 那会在用户没点的时候偷偷换节点。
       */
      var onPick = useCallback(function (name) {
        if (busy !== '') return
        setBusy('pick')
        call('/nodes?limit=' + UI.nodeListLimit, { method: 'POST', body: { node: name } }).then(function (payload) {
          if (payload !== null) {
            setNodes(payload)
            if (payload.error) setError(payload.error)
          }
          return refresh()
        }).finally(function () { setBusy('') })
      }, [busy, refresh])

      var onCalibrate = useCallback(function () {
        setBusy('calibrate')
        setError('')
        call('/calibrate', { method: 'POST' }).then(function (payload) {
          if (payload === null) { setError(t('page.errCalibrate')); return }
          if (payload.ok !== true) setError(payload.detail || payload.reason || t('page.errCalibrate'))
          return refresh()
        }).finally(function () { setBusy('') })
      }, [refresh])

      /**
       * 一键修网络。
       *
       * 针对这个真实事故：Clash 非正常退出后 DNS 停在 198.18.0.2，
       * 内核已死 → 整机解析全挂。看门狗会自动修，这颗按钮是手动兜底
       * （比如看门狗被关掉、或用户想在启动前先清一遍）。
       */
      var onNetHeal = useCallback(function () {
        if (busy !== '') return
        setBusy('heal')
        setNetHeal('')
        call('/net', { method: 'POST' }).then(function (payload) {
          if (payload === null) { setNetHeal(t('page.healFailed')); return }
          setNetHeal(payload.ok === true ? t('page.healDone') : (t('page.healPartial') + (payload.remaining ?? []).length))
          return refresh()
        }).finally(function () { setBusy('') })
      }, [busy, refresh])

      var onToggle = useCallback(function (group, key, value) {
        setSettings(function (prev) {
          if (prev === null) return prev
          var next = JSON.parse(JSON.stringify(prev))
          if (!next[group]) next[group] = {}
          next[group][key] = value
          return next
        })
      }, [])

      var onSave = useCallback(function () {
        if (settings === null || busy !== '') return
        setBusy('save')
        setSaved('')
        call('/settings', { method: 'POST', body: settings }).then(function (payload) {
          if (payload === null || payload.ok !== true) {
            setSaved(t('page.saveFailed'))
            return
          }
          setSaved(t('page.saved'))
          if (payload.settings) setSettings(payload.settings)
        }).finally(function () { setBusy('') })
      }, [settings, busy])

      /* —— 首屏 / 不可达 —— */
      if (state === null) {
        return h('div', { className: 'dskg', translate: 'no', dir: 'ltr' },
          h('div', { className: 'dskg-card' },
            h('div', { className: 'dskg-empty' }, t('page.loading'))))
      }

      var head = h('div', { className: 'dskg-head' },
        h('h2', { className: 'dskg-title' }, t('page.title')),
        h('p', { className: 'dskg-sub' }, t('page.subtitle')))

      /**
       * 错误横幅。
       *
       * **这是修补一个真实缺陷**：err 状态在 12 处被 setError 写入，
       * 但面板里从来没有渲染它 —— 所有错误（内核启动失败、模式切换失败、
       * 节点刷新失败…）都被静默吞掉，用户点了没反应也不知道为什么。
       */
      var errBanner = error !== ''
        ? h('div', { className: 'dskg-error', role: 'alert' },
          h('span', { className: 'dskg-error-mark', 'aria-hidden': 'true' }, '!'),
          h('span', { className: 'dskg-error-text' }, error),
          h('button', {
            className: 'dskg-error-close',
            type: 'button',
            'aria-label': t('page.dismiss'),
            onClick: function () { setError('') },
          }, '×'))
        : null

      if (state.reachable !== true) {
        var offline = []
        offline.push(head)
        offline.push(h('div', { key: 'unreachable', className: 'dskg-card' },
          h('div', { className: 'dskg-section-title' }, t('page.notReachable')),
          h('p', { className: 'dskg-note' }, state.error || ''),
          (state.attempts && state.attempts.length > 0)
            ? h('div', { className: 'dskg-checks' },
              state.attempts.map(function (attempt, index) {
                return h('div', { key: String(index), className: 'dskg-check', 'data-ok': attempt.ok ? '1' : '0' },
                  h('span', { className: 'dskg-mark' }, attempt.ok ? '✔' : '✘'),
                  h('div', null,
                    h('div', { className: 'dskg-t' }, attempt.source),
                    h('div', { className: 'dskg-d' }, attempt.transport + ' · ' + (attempt.error || attempt.version || ''))),
                  h('span', { className: 'dskg-s' }, ''))
              }))
            : null,
          h('div', { className: 'dskg-row', style: { marginTop: '12px' } },
            h('button', { className: 'dskg-btn', type: 'button', onClick: refresh }, t('page.refresh')))))

        // 内核不在正是最需要「启动内核」的时候，所以在不可达分支里也给这份控件
        if (kernel !== null) {
          offline.push(h(Card, {
            key: 'kernel-offline',
            title: t('page.sectionKernel'),
            note: t('page.sectionKernelNote'),
          },
          h('dl', { className: 'dskg-kv', style: { marginTop: '0' } },
            h('dt', null, t('page.kernelCore')),
            h('dd', null, kernel.coreRunning ? t('page.running') : t('page.stopped')),
            h('dt', null, t('page.kernelService')),
            h('dd', null, kernel.serviceExists
              ? (kernel.serviceRunning ? t('page.running') : t('page.stopped'))
              : '—'),
            h('dt', null, t('page.kernelGui')),
            h('dd', null, kernel.guiRunning ? t('page.running') : t('page.stopped'))),
          h('p', { className: 'dskg-hint', style: { marginTop: '8px' } }, kernel.summary),
          h('div', { className: 'dskg-row', style: { marginTop: '10px' } },
            h('button', {
              className: 'dskg-btn',
              type: 'button',
              'data-primary': '1',
              disabled: busy !== '',
              onClick: function () { onKernel('start') },
            }, busy === 'kernel:start' ? t('page.starting') : t('page.startKernel')),
            h('button', {
              className: 'dskg-btn',
              type: 'button',
              disabled: busy !== '',
              title: t('page.healHint'),
              onClick: onNetHeal,
            }, busy === 'heal' ? t('page.healing') : t('page.healNet')),
            netHeal !== '' ? h('span', { className: 'dskg-hint' }, netHeal) : null,
            h('button', {
              className: 'dskg-btn',
              type: 'button',
              disabled: busy !== '',
              onClick: function () { onKernel('restart') },
            }, busy === 'kernel:restart' ? t('page.restarting') : t('page.restartKernel')))))
        }

        if (errBanner !== null) offline.push(h('div', { key: 'errBanner' }, errBanner))
        if (error !== '') offline.push(h('div', { key: 'error', className: 'dskg-err' }, error))
        return h('div', { className: 'dskg', translate: 'no', dir: 'ltr' }, offline)
      }

      var body = [head]
      if (errBanner !== null) body.push(errBanner)

      /* —— 内核与服务（放最前：内核不在，下面全都无从谈起）—— */
      if (kernel !== null && typeof kernel === 'object') {
        var corePids = Array.isArray(kernel.corePids) ? kernel.corePids : []
        var guiPids = Array.isArray(kernel.guiPids) ? kernel.guiPids : []
        body.push(h(Card, {
          key: 'kernel',
          title: t('page.sectionKernel'),
          note: t('page.sectionKernelNote'),
        },
        h('dl', { className: 'dskg-kv', style: { marginTop: '0' } },
          h('dt', null, t('page.kernelCore')),
          h('dd', null,
            (kernel.coreRunning === true ? t('page.running') : t('page.stopped'))
            + (corePids.length > 0 ? ` · PID ${corePids.join(', ')}` : '')),
          h('dt', null, t('page.kernelController')),
          h('dd', null,
            (kernel.controllerAlive === true ? t('page.alive') : t('page.dead'))
            + (kernel.version ? ` · ${kernel.version}` : '')),
          h('dt', null, t('page.kernelService')),
          h('dd', null,
            kernel.serviceExists === true
              ? (kernel.serviceRunning === true ? t('page.running') : t('page.stopped'))
                + (kernel.serviceStartMode ? ` · ${kernel.serviceStartMode}` : '')
              : '—'),
          h('dt', null, t('page.kernelGui')),
          h('dd', null, kernel.guiRunning === true
            ? `${t('page.running')} · PID ${guiPids.join(', ')}`
            : t('page.stopped')),
          h('dt', null, t('page.kernelDesired')),
          h('dd', null, kernel.desiredCoreShouldRun === null || kernel.desiredCoreShouldRun === undefined
            ? '—'
            : (kernel.desiredCoreShouldRun === true ? t('page.required') : t('page.notRequired')))),
        kernel.summary ? h('p', { className: 'dskg-hint', style: { marginTop: '8px' } }, kernel.summary) : null,
        h('p', { className: 'dskg-hint' }, t('page.independentNote')),
        h('div', { className: 'dskg-row', style: { marginTop: '10px' } },
          h('button', {
            className: 'dskg-btn',
            type: 'button',
            'data-primary': kernel.controllerAlive === true ? '0' : '1',
            disabled: busy !== '' || kernel.controllerAlive === true,
            onClick: function () { onKernel('start') },
          }, busy === 'kernel:start' ? t('page.starting') : t('page.startKernel')),
          h('button', {
            className: 'dskg-btn',
            type: 'button',
            disabled: busy !== '' || kernel.coreRunning !== true,
            onClick: function () { onKernel('restart') },
          }, busy === 'kernel:restart' ? t('page.restarting') : t('page.restartKernel')))))
      }

      /* —— 模式 —— */
      body.push(h(Card, {
        key: 'mode',
        title: t('page.sectionMode'),
        note: t('page.sectionModeNote'),
      },
      h('div', { className: 'dskg-seg' },
        MODE_KEYS.map(function (mode) {
          return h('button', {
            key: mode,
            type: 'button',
            'data-on': current === mode ? '1' : '0',
            'data-mode': mode,
            disabled: busy !== '' || current === mode,
            onClick: function () { onMode(mode) },
            title: modeHint(mode),
          }, busy === 'mode' && current !== mode ? t('pill.busy') : modeLabel(mode))
        })),
      h('dl', { className: 'dskg-kv' },
        h('dt', null, t('page.currentMode')),
        h('dd', null, modeLabel(current) + '（内核 ' + (state.mode || '?') + '）'),
        h('dt', null, t('page.controller')),
        h('dd', null, (TRANSPORT_LABEL[state.transport] || state.transport || '?')
          + (state.source ? ' · ' + sourceLabel(state.source) : '')),
        h('dt', null, t('page.mixedPort')),
        h('dd', null, String(state.mixedPort || '?')),
        h('dt', null, t('page.elevated')),
        h('dd', null, state.elevated ? t('page.elevatedYes') : t('page.elevatedNo')),
        h('dt', null, t('page.realIp')),
        h('dd', null, state.realIp || t('page.realIpUnknown')))))

      /* —— 审计 —— */
      body.push(h(Card, {
        key: 'audit',
        title: t('page.sectionAudit'),
        note: t('page.sectionAuditNote'),
      },
      h('div', { className: 'dskg-row' },
        h('button', {
          className: 'dskg-btn',
          type: 'button',
          'data-primary': '1',
          disabled: busy !== '',
          title: t('page.auditHint'),
      onClick: onAudit,
        }, busy === 'audit' ? t('page.auditing') : t('page.runAudit')),
        h('button', {
          className: 'dskg-btn',
          type: 'button',
          disabled: busy !== '',
          title: t('page.calibrateHint'),
      onClick: onCalibrate,
        }, busy === 'calibrate' ? t('page.calibrating') : t('page.calibrate')),
        audit !== null
          ? h('span', { className: 'dskg-verdict', 'data-v': audit.verdict },
            audit.verdict === 'safe' ? t('page.verdictSafe')
              : audit.verdict === 'leaking' ? t('page.verdictLeaking') : t('page.verdictUnprotected'))
          : null),
      audit !== null
        ? h('dl', { className: 'dskg-kv' },
          h('dt', null, t('page.egress')),
          h('dd', null, audit.snapshot.egressIp || '—'),
          h('dt', null, t('page.realIp')),
          h('dd', null, audit.snapshot.realIp || t('page.realIpUnknown')),
          h('dt', null, t('page.connections')),
          h('dd', null, String(audit.snapshot.totalConnections)
            + ' / ' + t('page.directConnections') + ' ' + String(audit.snapshot.directConnections)))
        : null,
      audit !== null
        ? h('div', { className: 'dskg-checks' },
          audit.checks.map(function (check) { return h(CheckRow, { key: check.id, check: check }) }))
        : null))

      /* —— 节点 —— */
      body.push(h(Card, {
        key: 'nodes',
        title: t('page.sectionNodes'),
        note: t('page.sectionNodesNote'),
      },
      h('div', { className: 'dskg-row' },
        h('button', { className: 'dskg-btn', type: 'button', disabled: busy !== '', onClick: onNodes },
          busy === 'nodes' ? t('page.refreshing') : t('page.refresh')),
        h('button', {
          className: 'dskg-btn',
          type: 'button',
          disabled: busy !== '',
          title: t('page.speedTestHint'),
          onClick: onLatency,
        }, busy === 'latency' ? t('page.testing') : t('page.speedTest')),
        nodes !== null && nodes.current ? h('span', { className: 'dskg-hint' }, nodes.current) : null),
      nodes !== null && nodes.nodes && nodes.nodes.length > 0
        ? h('div', { className: 'dskg-nodes' },
          nodes.nodes.map(function (node) {
            // 延迟分级：一列数字看不出好坏，颜色能一眼扫。
            var tier = 'ok'
            if (!node.alive) tier = 'dead'
            else if (node.delay > 0 && node.delay < 150) tier = 'fast'
            else if (node.delay >= 1000) tier = 'slow'
            return h('button', {
              key: node.name,
              type: 'button',
              className: 'dskg-node',
              'data-on': nodes.current === node.name ? '1' : '0',
              disabled: busy !== '',
              title: node.name + (node.alive ? '' : '（不可用）'),
              onClick: function () { onPick(node.name) },
            },
            h('span', { className: 'dskg-nm' }, node.name),
            h('span', { className: 'dskg-ty' }, node.type),
            h('span', { className: 'dskg-lat', 'data-tier': tier },
              node.alive ? (node.delay > 0 ? String(node.delay) + 'ms' : '—') : '不可用'))
          }))
        : h('div', { className: 'dskg-hint', style: { marginTop: '10px' } }, t('page.nodesIdle'))))

      /* —— 加固项开关 —— */
      if (settings !== null && settings.harden) {
        var toggles = [
          ['strictRoute', t('page.toggleStrictRoute')],
          ['systemProxy', t('page.toggleSystemProxy')],
          ['winHttpProxy', t('page.toggleWinHttp')],
          ['disableIpv6', t('page.toggleIpv6')],
          ['pointDns', t('page.togglePointDns')],
          ['disableAutoDoh', t('page.toggleAutoDoh')],
          ['closeConnections', t('page.toggleCloseConnections')],
        ]
        body.push(h(Card, {
          key: 'settings',
          title: t('page.sectionSettings'),
          note: t('page.sectionSettingsNote'),
        },
        toggles.map(function (row) {
          var key = row[0]
          var label = row[1]
          return h('label', { key: key, className: 'dskg-toggle' },
            h('input', {
              type: 'checkbox',
              checked: settings.harden[key] === true,
              onChange: function (event) { onToggle('harden', key, event.target.checked) },
            }),
            h('span', null, label))
        }),
        h('div', { className: 'dskg-row', style: { marginTop: '12px' } },
          h('button', { className: 'dskg-btn', type: 'button', 'data-primary': '1', disabled: busy !== '', onClick: onSave },
            busy === 'save' ? t('page.saving') : t('page.saveSettings')),
          saved ? h('span', { className: 'dskg-hint' }, saved) : null)))
      }

      if (error !== '') body.push(h('div', { key: 'error', className: 'dskg-err' }, error))

      return h('div', { className: 'dskg', translate: 'no', dir: 'ltr' }, body)
    }

    /* ------------------------------------------------------------------ *
     * 输入框旁的三段式小开关（可选座位，槽位由宿主下发）
     * ------------------------------------------------------------------ */

    function ModePill() {
      var pair = useState(null)
      var state = pair[0]
      var setState = pair[1]
      var busyPair = useState('')
      var busy = busyPair[0]
      var setBusy = busyPair[1]

      var refresh = useCallback(function () {
        return call('/state').then(function (payload) {
          setState(payload === null ? { reachable: false } : payload)
        })
      }, [])

      useEffect(function () {
        var alive = true
        loadDictionary().then(function () { if (alive) refresh() })
        var timer = setInterval(function () { if (alive) refresh() }, UI.statePollMs)
        return function () { alive = false; clearInterval(timer) }
      }, [refresh])

      var current = state && state.reachable ? state.modeName : ''

      var onPick = useCallback(function (mode) {
        if (busy !== '') return
        setBusy(mode)
        call('/mode', { method: 'POST', body: { mode: mode } })
          .then(refresh)
          .finally(function () { setBusy('') })
      }, [busy, refresh])

      if (state === null || state.reachable !== true) return null

      return h('div', { className: 'dskg-seg', style: { padding: '2px' } },
        MODE_KEYS.map(function (mode) {
          return h('button', {
            key: mode,
            type: 'button',
            'data-on': current === mode ? '1' : '0',
            'data-mode': mode,
            disabled: busy !== '' || current === mode,
            onClick: function (onEvent) { onEvent.stopPropagation(); onPick(mode) },
            style: { padding: '4px 10px', fontSize: '11px' },
          }, busy === mode ? '…' : modeLabel(mode))
        }))
    }

    /* ------------------------------------------------------------------ *
     * 出口 IP 指示灯
     *
     * 与「AI 控制电脑」同一个座位（`conversation.input.left`）、同一套视觉：
     * 6px 圆点 + 13px/500 文案，高 28px，无边框无底色，点亮时圆点带 3px 同色光晕。
     *
     * 它**只显示与检查，不切换模式** —— 切换在侧边栏面板里。理由：这个座位
     * 只有一行高，塞三段式按钮会把旁边的控件挤走；而且指示灯的价值是「一眼
     * 看出现在安不安全」，不是「顺手改配置」。
     * ------------------------------------------------------------------ */

    var INDICATOR_TONE = {
      on: 'on',
      warn: 'warn',
      off: 'off',
    }

    /** 把 {a} 占位符填上。 */
    function fill(text, params) {
      if (!params) return text
      return text.replace(/\{(\w+)\}/g, function (match, key) {
        return Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : match
      })
    }

    /**
     * 严重度的中文标签。
     *
     * 内部 id 仍是 critical/high/medium/low（那是 defaults 里的键，
     * 改它会破坏配置兼容），只在**显示**时翻译 —— 数据与呈现分离。
     */
    var SEVERITY_LABEL = {
      critical: '严重',
      high: '高',
      medium: '中',
      low: '低',
    }

    /** 传输方式的中文标签。 */
    var TRANSPORT_LABEL = {
      pipe: '命名管道',
      tcp: 'TCP 端口',
      none: '未连接',
    }

    /** 发现来源的中文标签（形如 `process:command-line`）。 */
    function sourceLabel(source) {
      var text = String(source || '')
      if (text === '') return ''
      var map = {
        'process:command-line': '内核进程命令行',
        'pipe:enumeration': '管道枚举',
        'settings:pipeName': '设置里指定',
        'settings:controllerUrl': '设置里指定',
      }
      if (Object.prototype.hasOwnProperty.call(map, text)) return map[text]
      if (text.indexOf('config:') === 0) {
        return '配置文件 ' + text.slice(7).replace(/:.*$/, '')
      }
      return text
    }

    function IpIndicator() {
      var pair = useState(null)
      var data = pair[0]
      var setData = pair[1]
      var busyPair = useState(false)
      var busy = busyPair[0]
      var setBusy = busyPair[1]
      /**
       * 本次检测的序号。
       *
       * 轮询与手动点击可能并发，慢的那个后到会把新结果覆盖成旧值。
       * 每次发起都递增，回来时只接受序号最新的那一次。
       */
      var seqPair = useState(0)
      var seq = seqPair[0]
      var setSeq = seqPair[1]

      /**
       * 跑一次检测。
       *
       * **不改已有结论**。上一轮实测教训：把「检测中」设成最高优先级盖住结论，
       * 而一次探测要 8 秒、每 30 秒轮询一次 —— 于是约四分之一的时间都在显示
       * 「检测中」，用户根本不知道自己现在安不安全。
       *
       * 现在：结论永远显示，进行中只体现在悬停提示与圆点的轻微脉动上。
       * 只有**从未拿到过任何结论**时才显示「检测中」。
       */
      var check = useCallback(function (manual) {
        if (busy === true) return Promise.resolve(null)
        setBusy(true)
        setSeq(function (prev) { return prev + 1 })
        return call('/ip').then(function (payload) {
          if (payload !== null) setData(payload)
          return payload
        }).finally(function () { setBusy(false) })
      }, [busy])

      useEffect(function () {
        var alive = true
        loadDictionary().then(function () { if (alive && UI.indicatorProbeOnMount === true) check(false) })
        var timer = setInterval(function () { if (alive) check(false) }, UI.indicatorPollMs)
        return function () { alive = false; clearInterval(timer) }
      }, [check])

      // 只有**真的没有结论**时才显示「检测中」。
      // 有结论就一直显示结论 —— 即使后台正在刷新。
      var hasVerdict = data !== null && data.phase !== 'checking'
      var checking = !hasVerdict
      var phase = checking ? 'checking' : (data.phase || 'checking')
      var tone = checking ? 'checking' : (data.tone || 'off')

      // 未校准用**空心中点**：实心=已知、空心=未知。
      // 它和「可绕过」都是黄系，但一个是「知道有风险」，一个是「还不知道」——
      // 混在一起会让用户误判。
      if (!checking && data.verdict === 'uncalibrated') tone = 'unknown'
      // 无出口用**灰点**：不是风险，是「测不到」。
      // 用黄色会让用户以为出了安全问题，其实只是断网。
      if (!checking && (data.verdict === 'no-egress' || data.phase === 'no-egress')) tone = 'idle'

      var head = t('indicator.label')
      var label = t('indicator.checking')
      var tip = t('indicator.tipChecking')

      if (phase === 'ok') {
        if (data.verdict === 'masked') {
          label = t('indicator.masked')
          tip = fill(t('indicator.tipMasked'), {
            proxy: data.proxy && data.proxy.ip ? data.proxy.ip : '—',
            real: data.realIp || '—',
          })
        } else if (data.verdict === 'exposed') {
          label = t('indicator.exposed')
          tip = fill(t('indicator.tipExposed'), { real: data.realIp || '—' })
        } else if (data.verdict === 'bypassable') {
          label = t('indicator.bypassable')
          tip = fill(t('indicator.tipBypassable'), {
            bound: data.bound && data.bound.ip ? data.bound.ip : '—',
            real: data.realIp || '—',
          })
        } else {
          label = t('indicator.uncalibrated')
          tip = t('indicator.tipUncalibrated')
        }
      } else if (phase === 'unreachable') {
        // 控制器挂了但整机出口可能还在 —— 这时更该看系统/绑卡两条路径
        if (data.system && data.system.ok) {
          label = t('indicator.systemOnly')
          tip = fill(t('indicator.tipSystemOnly'), {
            system: data.system.ip,
            real: data.realIp || '—',
          })
        } else {
          label = t('indicator.unreachable')
          tip = t('indicator.tipUnreachable')
        }
      } else if (phase === 'no-egress') {
        label = t('indicator.noEgress')
        tip = t('indicator.tipNoEgress')
      } else if (phase === 'error') {
        label = t('indicator.unreachable')
        tip = data.error || t('indicator.tipUnreachable')
      }

      // 三条路径的明细拼进 title —— 悬停就能看到整机情况
      var detail = []
      if (data !== null && phase !== 'checking') {
        if (data.system && data.system.ip) detail.push(fill(t('indicator.pathSystem'), { ip: data.system.ip }))
        if (data.proxy && data.proxy.ip) detail.push(fill(t('indicator.pathProxy'), { ip: data.proxy.ip }))
        if (data.bound && data.bound.ip) detail.push(fill(t('indicator.pathBound'), { ip: data.bound.ip }))
        if (data.realIp) detail.push(fill(t('indicator.pathReal'), { ip: data.realIp }))
        else detail.push(t('indicator.pathRealMissing'))
      }

      // 「正在刷新」只出现在悬停提示里，绝不占据常显文案。
      // 有结论时先给结论，再补一行「正在刷新…」；没结论时才以「检测中」开头。
      var fullTip
      if (checking) {
        fullTip = t('indicator.tipChecking')
      } else {
        fullTip = tip
        if (detail.length > 0) fullTip += '\n\n' + detail.join('\n')
        if (busy === true) fullTip += '\n\n' + t('indicator.refreshing')
      }
      fullTip += '\n\n' + t('indicator.tipClick')

      return h('button', {
        type: 'button',
        className: 'dsip',
        'data-tone': tone,
        // data-checking 只表示「还没有任何结论」；后台刷新用 data-refreshing，
        // 它只驱动圆点的轻微脉动，不动文案。
        'data-checking': checking ? '1' : '0',
        'data-refreshing': busy === true && !checking ? '1' : '0',
        'aria-busy': busy === true ? 'true' : 'false',
        title: fullTip,
        'aria-label': head + ': ' + label,
        onClick: function (event) {
          if (typeof event.stopPropagation === 'function') event.stopPropagation()
          check(true)
        },
      },
      h('span', { className: 'dsip-dot', 'data-tone': tone, 'aria-hidden': 'true' }),
      h('span', { className: 'dsip-label' }, head),
      h('span', { className: 'dsip-value' }, label))
    }


    /** 读服务，绝不用属性访问（cordis 对未注入的服务会抛）。 */
    function readService(ctx, name) {
      try {
        var get = ctx && ctx.get
        if (typeof get !== 'function') return undefined
        var value = get.call(ctx, name)
        return value === undefined || value === null ? undefined : value
      } catch (error) {
        return undefined
      }
    }

    /**
     * 挂载侧边栏一级入口 + 主面板。
     *
     * `sidebar.panellist` 出导航行（shell 拥有按钮本体与点击），
     * `main` keyed 槽位按同一 id 渲染整页。两个 id 必须一致。
     *
     * @param {object} ctx 客户端根上下文
     * @returns {() => void} 释放函数
     */
    function mountSidebarPanel(ctx) {
      var slots = readService(ctx, 'slots')
      if (slots === undefined || typeof slots.inject !== 'function') {
        console.warn('[dsh-clash-guard] slots 服务不可用，跳过侧边栏入口')
        return function () {}
      }

      var panelId = UI.panelId
      if (panelId === '') {
        console.warn('[dsh-clash-guard] 宿主未下发 ui.panelId，跳过侧边栏入口')
        return function () {}
      }

      var disposers = { page: null, row: null }
      var attempts = 0
      var stopped = false

      var registerAll = function () {
        var complete = true

        if (!disposers.page) {
          try {
            disposers.page = slots.inject('main', function () {
              return slots.register({ name: 'main', key: panelId }, function () { return h(GuardPanel) })
            })
          } catch (error) {
            complete = false
            console.warn('[dsh-clash-guard] main 面板注册失败：', error)
          }
        }

        if (!disposers.row) {
          try {
            // 槽位名来自 defaults.ui.panelSlot，不写字面量 ——
            // 侧边栏行的「行」与「页」必须用同一个槽位名，写成两处字面量迟早写歪。
            disposers.row = slots.inject(UI.panelSlot, function () {
              return slots.register({
                name: UI.panelSlot,
                id: panelId,
                order: UI.panelOrder,
                label: function () {
                  return documentLang() === 'en'
                    ? (UI.panelLabelEn || UI.panelLabelZh || panelId)
                    : (UI.panelLabelZh || UI.panelLabelEn || panelId)
                },
              }, ShieldIcon)
            })
          } catch (error) {
            complete = false
            console.warn('[dsh-clash-guard] 侧边栏行注册失败：', error)
          }
        }

        return complete
      }

      var attempt = function () {
        if (stopped) return
        if (registerAll()) return
        attempts += 1
        if (attempts < UI.maxAttempts) {
          try {
            setTimeout(attempt, UI.retryDelayMs)
          } catch (error) {
            /* 没有 timer 就只试这一次 */
          }
        } else {
          console.warn('[dsh-clash-guard] 侧边栏入口注册未完成（已重试 ' + UI.maxAttempts + ' 次）')
        }
      }

      attempt()

      return function () {
        stopped = true
        for (var key in disposers) {
          if (!Object.hasOwn(disposers, key)) continue
          var dispose = disposers[key]
          if (typeof dispose !== 'function') continue
          try { dispose() } catch (error) { /* 卸载阶段尽力而为 */ }
        }
        disposers.page = null
        disposers.row = null
      }
    }

    /**
     * 出口 IP 指示灯。
     *
     * 与输入框小开关互斥：
     *   · `enableIndicator`（默认开）→ 注册指示灯，只显示不切换；
     *   · `enablePill`（默认关）→ 注册三段式小开关。
     * 两个都开就都注册（座位不同 id，不会冲突），但默认只留指示灯。
     */
    function mountIndicator(ctx) {
      if (UI.enableIndicator !== true) return function () {}
      var slots = readService(ctx, 'slots')
      if (slots === undefined || typeof slots.inject !== 'function') return function () {}
      if (UI.indicatorSlot === '' || UI.indicatorId === '') return function () {}
      try {
        return slots.inject(UI.indicatorSlot, function () {
          return slots.register({
            name: UI.indicatorSlot,
            id: UI.indicatorId,
            order: UI.indicatorOrder,
          }, function () { return h(IpIndicator) })
        })
      } catch (error) {
        console.warn('[dsh-clash-guard] 指示灯注册跳过：', error)
        return function () {}
      }
    }

    /**
     * 输入框旁的小开关。
     *
     * **默认不注册**（`ui.enablePill = false`）：唯一入口是侧边栏「代理守卫」。
     * 同一功能给两个入口会让人以为它们是两件事，而且输入框那一行本来就挤。
     * 想加回来在 defaults.json（或设置页）把 `ui.enablePill` 置 true 即可。
     */
    function mountPill(ctx) {
      if (UI.enablePill !== true) return function () {}
      var slots = readService(ctx, 'slots')
      if (slots === undefined || typeof slots.inject !== 'function') return function () {}
      if (UI.pillSlot === '' || UI.pillId === '') return function () {}
      try {
        return slots.inject(UI.pillSlot, function () {
          return slots.register({
            name: UI.pillSlot,
            id: UI.pillId,
            order: UI.pillOrder,
          }, function () { return h(ModePill) })
        })
      } catch (error) {
        console.warn('[dsh-clash-guard] 输入框开关注册跳过：', error)
        return function () {}
      }
    }

    /**
     * 先拉一次宿主配置把 UI 填满，再挂载。
     *
     * 槽位名、面板 id、磨砂配方都必须来自宿主 —— 不能写死在客户端。
     * 宿主不可达时只记一条日志，不注册任何座位，绝不弄坏界面。
     */
    function apply(ctx) {
      try {
        installStyles()
      } catch (error) {
        console.warn('[dsh-clash-guard] 样式安装失败：', error)
      }

      var mounted = false
      var release = function () {}

      var mount = function () {
        if (mounted) return
        mounted = true
        try {
          installStyles()
          var stopPanel = mountSidebarPanel(ctx)
          var stopIndicator = mountIndicator(ctx)
          var stopPill = mountPill(ctx)
          release = function () {
            try { stopPanel() } catch (error) { /* ignore */ }
            try { stopIndicator() } catch (error) { /* ignore */ }
            try { stopPill() } catch (error) { /* ignore */ }
          }
        } catch (error) {
          console.warn('[dsh-clash-guard] 挂载失败：', error)
        }
      }

      var effect = ctx && ctx.effect
      if (typeof effect === 'function') {
        try {
          effect.call(ctx, function () { return release }, 'dsh-clash-guard: sidebar entry')
        } catch (error) {
          /* 没有 effect 动词时由 fiber 自己的 teardown 释放 */
        }
      }

      call('/state').then(function (payload) {
        if (payload !== null && payload.settings) adoptUi(payload.settings)
        return loadDictionary()
      }).then(mount).catch(function (error) {
        console.warn('[dsh-clash-guard] 宿主配置读取失败，尝试用默认值挂载：', error)
        mount()
      })
    }

    exports.apply = apply
    exports.inject = ['slots']
    exports.__internals = {
      buildCss: buildCss,
      t: t,
      call: call,
      adoptUi: adoptUi,
      loadDictionary: loadDictionary,
      UI: UI,
      GuardPanel: GuardPanel,
      ModePill: ModePill,
      IpIndicator: IpIndicator,
      CheckRow: CheckRow,
      ShieldIcon: ShieldIcon,
      MODE_KEYS: MODE_KEYS,
      SEVERITY_LABEL: SEVERITY_LABEL,
      TRANSPORT_LABEL: TRANSPORT_LABEL,
      sourceLabel: sourceLabel,
    }
    return module.exports
  },
})
