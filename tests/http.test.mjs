/**
 * HTTP 路由测试：用一个假的 webServer 与假的 tools，验证宿主半的接线。
 *
 * 不打网络：mihomo 与 windows 层都被替换成桩，只验路由注册、参数校验、
 * 应答形状、以及 apply() 永不抛。
 *
 * 跑法：node --test tests/http.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { registerRoutes } from '../lib/http.js'
import { loadConfig } from '../lib/settings.js'
import { stateFile } from '../lib/paths.js'

const { config } = loadConfig()

/** 收集注册的路由。 */
function fakeScoped() {
  const routes = new Map()
  return {
    routes,
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => { routes.delete(route.path) }
      },
    },
  }
}

/** 造一个假 req / res。 */
function fakeExchange(method, url, headers, body) {
  const req = {
    method,
    url,
    headers,
    on(event, handler) {
      if (event === 'data' && body !== undefined) handler(Buffer.from(body))
      if (event === 'end') handler()
      return req
    },
    destroy() {},
  }
  const chunks = []
  const res = {
    statusCode: 0,
    headers: {},
    headersSent: false,
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers ?? {}
      this.headersSent = true
    },
    end(payload) {
      if (payload !== undefined) chunks.push(Buffer.from(payload))
    },
    body() {
      return Buffer.concat(chunks).toString('utf8')
    },
    destroy() {},
  }
  return { req, res }
}

/** 调一次路由。 */
async function hit(route, method, url, body, contentType) {
  const headers = {}
  if (contentType !== undefined) headers['content-type'] = contentType
  const { req, res } = fakeExchange(method, url, headers, body)
  await route.handler(req, res)
  const text = res.body()
  let parsed = null
  try {
    parsed = text === '' ? null : JSON.parse(text)
  } catch {
    parsed = { __unparsed: text }
  }
  return { status: res.statusCode, headers: res.headers, json: parsed }
}

const deps = {
  configOf: () => config,
  saveConfig: patch => ({ ...config, ...patch }),
  paths: { stateFile: stateFile() },
}

test('注册全部七条路由', () => {
  const scoped = fakeScoped()
  const disposers = registerRoutes(scoped, deps)
  const prefix = config.http.prefix
  const expected = Object.values(config.http.routes).map(route => `${prefix}${route}`)
  for (const path of expected) {
    assert.ok(scoped.routes.has(path), `缺少路由 ${path}`)
  }
  assert.equal(disposers.length, expected.length, '释放函数数量必须与路由数一致')
  for (const dispose of disposers) dispose()
  assert.equal(scoped.routes.size, 0, '释放后路由必须全部注销')
})

test('GET /i18n 返回两份语言表', async () => {
  const scoped = fakeScoped()
  const disposers = registerRoutes(scoped, deps)
  const route = scoped.routes.get(`${config.http.prefix}${config.http.routes.i18n}`)
  const out = await hit(route, 'GET', route.path)
  assert.equal(out.status, 200)
  assert.equal(out.json.ok, true)
  assert.ok(out.json.table.zh, '必须有中文表')
  assert.ok(out.json.table.en, '必须有英文表')
  assert.ok(out.json.table.zh.pill.modeGlobal, '中文表必须有 pill.modeGlobal')
  assert.ok(out.json.table.en.pill.modeGlobal, '英文表必须有 pill.modeGlobal')
  for (const dispose of disposers) dispose()
})

test('POST /mode 拒绝非 JSON 请求', async () => {
  const scoped = fakeScoped()
  const disposers = registerRoutes(scoped, deps)
  const route = scoped.routes.get(`${config.http.prefix}${config.http.routes.mode}`)
  const out = await hit(route, 'POST', route.path, '{"mode":"global"}', 'text/plain')
  assert.equal(out.status, 415)
  assert.equal(out.json.ok, false)
  for (const dispose of disposers) dispose()
})

test('POST /mode 拒绝 GET 方法', async () => {
  const scoped = fakeScoped()
  const disposers = registerRoutes(scoped, deps)
  const route = scoped.routes.get(`${config.http.prefix}${config.http.routes.mode}`)
  const out = await hit(route, 'GET', route.path)
  assert.equal(out.status, 405)
  for (const dispose of disposers) dispose()
})

test('POST /mode 拒绝坏 JSON', async () => {
  const scoped = fakeScoped()
  const disposers = registerRoutes(scoped, deps)
  const route = scoped.routes.get(`${config.http.prefix}${config.http.routes.mode}`)
  const out = await hit(route, 'POST', route.path, 'not json at all', 'application/json')
  assert.equal(out.status, 400)
  assert.equal(out.json.error, 'bad-body')
  for (const dispose of disposers) dispose()
})

test('POST /mode 拒绝缺少 mode 字段', async () => {
  const scoped = fakeScoped()
  const disposers = registerRoutes(scoped, deps)
  const route = scoped.routes.get(`${config.http.prefix}${config.http.routes.mode}`)
  const out = await hit(route, 'POST', route.path, '{"other":1}', 'application/json')
  assert.equal(out.status, 400)
  for (const dispose of disposers) dispose()
})

test('GET /settings 回读当前配置', async () => {
  const scoped = fakeScoped()
  const disposers = registerRoutes(scoped, deps)
  const route = scoped.routes.get(`${config.http.prefix}${config.http.routes.settings}`)
  const out = await hit(route, 'GET', route.path)
  assert.equal(out.status, 200)
  assert.equal(out.json.ok, true)
  assert.equal(out.json.settings.http.prefix, config.http.prefix)
  assert.equal(out.json.settings.bypass.selectorGroup, config.bypass.selectorGroup)
  for (const dispose of disposers) dispose()
})

test('POST /settings 保存并回显', async () => {
  const scoped = fakeScoped()
  const disposers = registerRoutes(scoped, deps)
  const route = scoped.routes.get(`${config.http.prefix}${config.http.routes.settings}`)
  const out = await hit(route, 'POST', route.path, '{"harden":{"strictRoute":false}}', 'application/json')
  assert.equal(out.status, 200)
  assert.equal(out.json.ok, true)
  for (const dispose of disposers) dispose()
})

test('所有应答都带 no-store 与 json content-type', async () => {
  const scoped = fakeScoped()
  const disposers = registerRoutes(scoped, deps)
  const route = scoped.routes.get(`${config.http.prefix}${config.http.routes.i18n}`)
  const out = await hit(route, 'GET', route.path)
  assert.equal(out.headers['cache-control'], 'no-store')
  assert.ok(String(out.headers['content-type']).includes('application/json'))
  for (const dispose of disposers) dispose()
})

test('apply() 在没有任何服务时也不抛', async () => {
  const { apply } = await import('../lib/index.js')
  const calls = []
  const ctx = {
    logger: { info: m => calls.push(['info', m]), warn: m => calls.push(['warn', m]) },
    effect(fn) { fn(); return () => {} },
    inject() { throw new Error('no tools service') },
    webServer: { register() { return () => {} } },
  }
  assert.doesNotThrow(() => apply(ctx))
  assert.ok(calls.length > 0, '至少应该记一条日志')
})

test('apply() 在 ctx 完全为空时也不抛', async () => {
  const { apply } = await import('../lib/index.js')
  assert.doesNotThrow(() => apply({}))
})
