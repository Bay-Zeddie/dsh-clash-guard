/**
 * cordis 测试桩：模拟真实宿主 ctx。
 *
 * **webServer 必须走 inject**（index.js L139 的修复）—— 直传 ctx.webServer
 * 的旧形态在修复后不再被读取，路由一个都注册不上。
 *
 * 用法：
 *   const env = makeCordisStub({ webServer: {...}, tools: {...} })
 *   mod.apply(env.ctx)
 *   for (const e of env.effects) e.fn()   // 触发 effect
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/**
 * 构造 cordis 形态的测试上下文。
 *
 * @param {object} services 服务集（webServer / tools / ...）
 * @param {object} [opts] { onLog }
 * @returns {{ ctx: object, effects: Array, runEffects: Function }}
 */
export function makeCordisStub(services, opts) {
  const log = opts?.onLog ?? (() => {})
  const effects = []
  const ctx = {
    // cordis 服务访问器：inject 回调收到的服务集与 get() 一致
    get(name) { return services[name] },
    logger: { info: () => {}, warn: m => log(m) },
    effect(fn, label) {
      effects.push({ fn, label })
      // 立即执行（与真实宿主行为一致）并返回 dispose
      const d = fn()
      return () => { if (typeof d === 'function') d() }
    },
    inject(names, cb) { cb(services) },
  }
  return {
    ctx,
    effects,
    runEffects() {
      for (const e of effects) {
        try { e.fn() } catch (error) {
          console.error(`  effect 失败 (${e.label ?? 'unlabeled'}): ${error.message}`)
        }
      }
    },
  }
}

/** 加载插件宿主半并完成全部装配（含路由注册）。 */
export async function bootHost(services, opts) {
  const env = makeCordisStub(services, opts)
  const mod = await import(pathToFileURL(path.join(ROOT, 'lib', 'index.js')).href)
  mod.apply(env.ctx)
  env.runEffects()
  return env
}
