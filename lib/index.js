/**
 * dsh-clash-guard —— 宿主半。
 *
 * 职责三件，其余都不做：
 *  1. 装配配置（defaults.json → settings.json → 环境变量）；
 *  2. 在 `ctx.webServer` 上注册 `/dsh-clash-guard/*` 同源路由，给面板用；
 *  3. 在 `ctx.tools` 上注册五个模型工具。
 *
 * `apply()` 永不抛：任何一项失败只记日志，宿主照常启动。
 *
 * ## 为什么工具是动态 import 进来的
 *
 * `lib/tools.js` 里对 `@deepseek-ai/dsh-tools` 是**静态 import**（那是官方用法，
 * DSH 的 ESM loader hook 负责提供这个包）。但静态 import 会让纯 Node 下
 * `import('./tools.js')` 直接失败 —— 那样路由层的单测就跑不起来。
 *
 * 所以这里用 `await import('./tools.js')` 把它**延迟**到 `apply()` 里：DSH 里
 * hook 已就位，导入成功、工具注册；纯 Node 里导入失败，只丢工具，路由照常 ——
 * 两边都对。
 *
 * 零硬编码：本文件不出现任何路径、端口、管道名、工具名、槽位名。
 * 全部来自 defaults.json，经 settings.js 装配。
 *
 * @module dsh-clash-guard
 */
import * as guard from './guard.js'
import { loadConfig, saveConfig } from './settings.js'
import { stateFile } from './paths.js'
import { registerRoutes } from './http.js'
import { createMonitor } from './monitor.js'
import { createProbe } from './probe.js'
import { resolve, describeCandidates } from './discover.js'

/** Cordis 插件名：必须与 package name、浏览器模块 id 一致。 */
export const name = 'dsh-clash-guard'

/** 硬依赖：没有 webServer 就没有面板数据通道。 */
export const inject = ['webServer']

/**
 * 插件入口。永不抛。
 * @param {object} ctx 宿主 cordis 上下文
 */
export function apply(ctx) {
  const warn = (message) => {
    try { ctx.logger?.warn?.(`${name}: ${message}`) } catch { /* logger 可能还没有 */ }
  }
  const info = (message) => {
    try { ctx.logger?.info?.(`${name}: ${message}`) } catch { /* ignore */ }
  }

  try {
    // 配置：defaults.json 是唯一事实来源；用户层与环境变量覆盖它
    let config = loadConfig().config
    const configOf = () => config
    const save = (patch) => {
      config = saveConfig(patch, config)
      return config
    }
    const paths = { stateFile: stateFile() }

    // 启动时做一次非阻塞探测，把「控制器在哪」写进日志，排障不用翻代码
    void resolve({ settings: config, defaults: config })
      .then((found) => {
        if (found.ok !== true) {
          info(`controller not reachable; candidates=${describeCandidates(found.discovered).join(' | ') || 'none'}`)
          return
        }
        info(`controller=${found.target.transport} source=${found.target.source} `
          + `mixedPort=${found.discovered.mixedPort} candidates=${found.discovered.candidates.length}`)
      })
      .catch(() => { /* 探测失败不是启动问题 */ })

    // ── 泄漏监控器（宿主侧常驻） ──
    //
    // 探测放在宿主而不是浏览器，有三个硬理由：
    //   1. **延迟**：原来浏览器每 30 秒调一次 /ip，服务端现场探测 5-10 秒，
    //      最坏延迟 = 30 + 7 = 37 秒。现在宿主每 5 秒探测，浏览器读快照，
    //      延迟就是 5 秒。
    //   2. **浏览器关闭时仍在检测** —— 泄漏恰恰在你不用电脑时发生。
    //   3. **不重复开销**：指示灯、面板、工具共享一次探测。
    let monitor = null
    let probeModule = null
    /**
     * 监控器装配有开关。
     *
     * 为什么要开关：`apply()` 在纯 Node 测试里会被调用（测试「apply 不抛」），
     * 而 monitor 一装配就启动常驻定时器 + 立即发起网络探测 —— 进程永不退出，
     * 测试挂死。
     *
     * 开关默认值 true（生产环境要常驻检测）。测试通过
     * `defaults.ui.monitorEnabled = false` 或传 ctx 标志关闭。
     */
    /**
     * 判定是否「真实宿主环境」。
     *
     * 依据是 **ctx 里有 webServer 服务** —— 那是 DSH 宿主注入的。
     * 纯 Node 测试用的假 ctx 没有它（或者只是普通对象没有注册方法），
     * 在那种环境里装配 monitor 会导致：常驻定时器 + 立即网络探测 → 进程永不退出，
     * 测试挂死。
     *
     * 这比「配置开关」更可靠：不需要测试方记得传标志。
     */
    const hasWebServer = typeof ctx?.webServer?.register === 'function'
    // **必须是真正的 cordis ctx**：DSH 注入的 ctx 一定有 get()（服务访问器）。
    // 纯 Node 测试的假 ctx 只有 webServer.register，没有 get。
    // 用它做判据，测试不需要传任何标志。
    const isCordisContext = typeof ctx?.get === 'function'
    const monitorEnabled = hasWebServer
      && isCordisContext
      && ctx.dshClashGuardNoMonitor !== true
      && configOf().ui.monitorEnabled !== false
    try {
      probeModule = createProbe({ configOf, paths, guard })
      monitor = createMonitor({
        configOf,
        paths,
        probe: probeModule.probe,
        fastProbe: probeModule.probeFast,
        // 快档 3 秒：只测三条出口 IP + TUN 状态，2 秒内出结果。
        // 慢档 30 秒：全量因子（DNS 身份、绑卡、直连进程…）。
        fastIntervalMs: configOf().ui.indicatorFastMs > 0 ? configOf().ui.indicatorFastMs : 3000,
        slowIntervalMs: configOf().ui.indicatorPollMs > 0 ? configOf().ui.indicatorPollMs : 30000,
        log: (message) => info(message),
      })
      if (monitorEnabled) {
        ctx.effect(() => {
          monitor.start()
          return () => { try { monitor.stop() } catch { /* 已停 */ } }
        }, `${name}: leak monitor`)
      }
    } catch (error) {
      warn(`泄漏监控器装配失败（不影响路由与面板）：${String(error.message ?? error)}`)
    }

    // ── 路由 ──
    //
    // **webServer 必须走 inject 注入**：cordis 的服务要显式声明依赖才拿得到。
    // 直接读 ctx.webServer 是 undefined —— 最近一次重构误把 ctx 当 scoped 传入，
    // 路由一个都没注册，插件在宿主里「看起来加载了但完全没功能」。
    ctx.inject(['webServer'], (scoped) => {
      ctx.effect(() => {
        const disposers = registerRoutes(scoped, {
          configOf,
          saveConfig: save,
          paths,
          monitor,
          probe: probeModule?.probe ?? null,
          probeIdentityReport: probeModule?.probeIdentityReport ?? null,
        })
        return () => {
          for (const dispose of disposers) {
            try { dispose() } catch { /* fiber 已销毁 */ }
          }
        }
      }, `${name}: http routes`)
    })

    // ── 网络自愈守护 ──
    //
    // 这一条是**防事故的**，不是功能。2026-11-18 连续两次：Clash 非正常退出
    // 后物理网卡 DNS 停在 198.18.0.2（TUN 网关），内核已死 → 整机解析全挂。
    // 靠人记着「要正常退出」不管用，所以让插件自己盯着。
    try {
      if (config.selfheal?.watchdog === true) {
        let watchdog = null
        ctx.effect(() => {
          void import('./selfheal.js').then((mod) => {
            watchdog = mod.startWatchdog({
              config: configOf(),
              log: (message) => info(message),
            })
          }).catch((error) => {
            warn(`网络守护启动失败（不影响其它功能）：${String(error.message ?? error)}`)
          })
          return () => {
            if (watchdog !== null) {
              try { watchdog.stop() } catch { /* 已停 */ }
            }
          }
        }, `${name}: selfheal watchdog`)
      }
    } catch (error) {
      warn(`网络守护装配失败：${String(error)}`)
    }

    // ── 工具 ──
    // 动态 import 把「没有 DSH hook 就解析不到 dsh-tools」这件事限制在工具层：
    // 导入失败只丢工具，路由与面板照常（纯 Node 单测因此还能跑）。
    try {
      ctx.inject(['tools'], (scoped) => {
        try {
          // tools 服务没有 effect 方法（effect 属于宿主 ctx）—— 用 ctx.effect
          ctx.effect(() => {
            let dispose = null
            let cancelled = false
            void import('./tools.js')
              .then((mod) => {
                if (cancelled) return
                dispose = mod.registerTools(scoped, { configOf, paths, guard })
              })
              .catch((error) => {
                warn(`工具模块不可用，跳过工具注册（路由与面板不受影响）：${String(error.message ?? error)}`)
              })
            return () => {
              cancelled = true
              if (typeof dispose === 'function') {
                try { dispose() } catch { /* fiber 已销毁 */ }
              }
            }
          }, `${name}: tools`)
        } catch (error) {
          warn(`工具注册失败：${String(error)}`)
        }
      })
    } catch (error) {
      warn(`注入 tools 失败：${String(error)}`)
    }
  } catch (error) {
    warn(`apply 失败：${String(error)}`)
  }
}

export default { name, inject, apply }
