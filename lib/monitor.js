/**
 * 泄漏监控 —— 宿主侧常驻探测器。
 *
 * ## 为什么不在浏览器里探测
 *
 * 原来的做法：指示灯每 30 秒调一次 `GET /ip`，服务端现场跑一遍
 * 全部探针（DNS 身份、绑卡、直连进程、系统解析…）。实测单次 5-10 秒，
 * 于是：
 *
 *   · 检测占用 20-30% 的 CPU 时间窗
 *   · **最坏延迟 = 轮询周期 + 检测耗时 ≈ 37 秒**
 *   · 浏览器关掉就没有任何检测 —— 而泄漏恰恰在你不用电脑时发生
 *
 * ## 新架构
 *
 * 探测移到**宿主进程**里常驻跑（和 selfheal watchdog 同一个生命周期），
 * 结果写进内存快照。浏览器（以及任何工具）读快照，**永远拿最新**，
 * 延迟等于探测周期而不是「周期 + 探测耗时」。
 *
 * 关键收益：
 *   1. 延迟从 37 秒降到探测周期（默认 5 秒）
 *   2. 浏览器关闭时仍在检测 —— 那才是泄漏高发时段
 *   3. 多个消费者（指示灯/面板/工具）共享一次探测，不重复开销
 *   4. 快照永远可读，即使探测正在进行中（返回上一份 + 正在跑标记）
 */

/** 默认探测周期（毫秒）。配置在 defaults.ui.indicatorPollMs 之外的独立项。 */
const DEFAULT_FAST_INTERVAL_MS = 3000
const DEFAULT_SLOW_INTERVAL_MS = 30000

/**
 * 创建一个监控器。
 *
 * @param {object} options
 * @param {() => object} options.configOf 取配置（每次探测时读，配置可变）
 * @param {object} options.paths 状态文件路径
 * @param {(probe: Function) => Promise<object>} options.probe 实际探测函数
 * @param {number} [options.intervalMs] 探测周期
 * @param {(message: string) => void} [options.log]
 */
export function createMonitor(options) {
  const { configOf, paths, probe } = options
  const log = typeof options.log === 'function' ? options.log : () => {}
  const fastIntervalMs = Number(options.fastIntervalMs ?? 0) || DEFAULT_FAST_INTERVAL_MS
  const slowIntervalMs = Number(options.slowIntervalMs ?? 0) || DEFAULT_SLOW_INTERVAL_MS
  const fastProbe = options.fastProbe ?? null

  const state = {
    /** 最近一次完整结果 */
    snapshot: null,
    /** 最近一次探测完成的时刻 */
    at: 0,
    /** 快档正在探测 */
    running: false,
    /** 慢档正在探测（与快档独立，慢档不阻塞快档） */
    slowRunning: false,
    /** 探测失败次数（连续） */
    failures: 0,
    /** 探测总次数 */
    runs: 0,
    /** 停止标志 */
    stopped: false,
    /** 上次慢档的时刻 */
    slowAt: 0,
    /** 慢档定时器 */
    slowTimer: null,
    timer: null,
  }

  /**
   * 跑一次探测。
   *
   * **双档**：
   *   · 快档（fastIntervalMs，默认 3 秒）—— 只测三条出口 IP + TUN 状态。
   *     这是用户最关心的「IP 有没有暴露」，目标 2 秒内出结果。
   *   · 慢档（slowIntervalMs，默认 30 秒）—— 全量因子（DNS 身份反查、
   *     绑卡绕过、直连进程、系统解析）。贵但覆盖隐蔽泄漏。
   *
   * 快档的结论会**立即**成为快照（哪怕慢档还没跑完），
   * 所以「IP 暴露了」能在 3 秒内反映到指示灯，而不是等 30 秒。
   */
  async function tick(tier) {
    if (state.stopped) return null
    /**
     * 快慢档**各自独立**。
     *
     * 原来共用一个 running 标志 → 慢档 9 秒期间快档完全跑不了，
     * 快照年龄无限增长（实测到 12 秒还在涨）。
     *
     * 慢档是「补充」，不该阻塞「实时」。现在慢档在后台跑，
     * 快档照常每几秒更新一次。
     */
    const isSlow = tier === 'slow'
    if (isSlow) {
      if (state.slowRunning) return { skipped: true }
      state.slowRunning = true
    } else {
      if (state.running) return { skipped: true }
      state.running = true
    }
    state.runs += 1
    try {
      const config = configOf()
      const result = tier === 'fast' && fastProbe !== null
        ? await fastProbe({ config, paths })
        : await probe({ config, paths })
      state.snapshot = { ...result, tier: tier ?? 'slow' }
      state.at = Date.now()
      state.failures = 0
      return result
    } catch (error) {
      state.failures += 1
      // 探测失败**不清空快照** —— 保留上一份结论，
      // 但标记为「数据可能过期」。宁可显示旧结论，也不显示空白。
      log(`泄漏探测失败（连续 ${state.failures} 次）：${String(error.message ?? error)}`)
      return null
    } finally {
      if (isSlow) state.slowRunning = false
      else state.running = false
    }
  }

  /**
   * 调度：快档连续跑，每跑一次快档就判断该不该跑慢档。
   *
   * 不用两个定时器 —— 一个循环更简单，且天然避免慢档与快档重叠。
   */
  /**
   * 两个独立定时器：快档与慢档互不阻塞。
   *
   * 快档间隔必须**大于快档自身耗时**（实测 4 秒），否则永远在跑、
   * 永远不空闲。留 1.5 倍余量。
   */
  function scheduleFast() {
    if (state.stopped) return
    const interval = Math.max(fastIntervalMs, 1000)
    state.timer = setTimeout(() => {
      void tick('fast').finally(scheduleFast)
    }, interval)
    // 不拖住宿主退出
    if (typeof state.timer.unref === 'function') state.timer.unref()
  }

  function scheduleSlow() {
    if (state.stopped) return
    state.slowTimer = setTimeout(() => {
      void tick('slow').finally(scheduleSlow)
    }, slowIntervalMs)
    if (typeof state.slowTimer.unref === 'function') state.slowTimer.unref()
  }

  return {
    /**
     * 读当前快照。
     *
     * **永远立即返回** —— 不等待正在进行的探测。若快照还没建立，
     * 返回 `{ ready: false }` 让调用方知道「还没有结论」。
     */
    read() {
      if (state.snapshot === null) {
        return { ready: false, running: state.running, at: 0 }
      }
      return {
        ...state.snapshot,
        ready: true,
        running: state.running,
        at: state.at,
        age: Date.now() - state.at,
        stale: state.failures > 0,
        runs: state.runs,
      }
    },
    /**
     * 强制立刻跑一次（不等周期）。
     *
     * 手动点击时用 —— 跑**慢档**拿全量结论（用户主动点了，要完整结果）。
     */
    refresh() {
      state.slowAt = Date.now()
      return tick('slow')
    },
    /**
     * 启动。
     *
     * **先快后慢**：快档 2-4 秒就能给出「IP 有没有暴露」的结论，
     * 而慢档要 9 秒（DNS 身份反查）。如果启动就跑慢档，用户打开
     * DSH 后前 10 秒指示灯是空的 —— 那正是最需要它的时候。
     *
     * 所以：先快档建立快照（立刻有结论），再慢档补全隐蔽因素。
     */
    start() {
      if (state.stopped) return
      state.stopped = false
      // 先快档（2-4 秒就有结论），慢档随后在后台补全
      const first = fastProbe !== null ? tick('fast') : tick('slow')
      void first.finally(() => {
        scheduleFast()
        scheduleSlow()
      })
    },
    stop() {
      state.stopped = true
      if (state.timer !== null) {
        clearTimeout(state.timer)
        state.timer = null
      }
      if (state.slowTimer !== null) {
        clearTimeout(state.slowTimer)
        state.slowTimer = null
      }
    },
    /** 内部状态（供测试） */
    _state: state,
  }
}
