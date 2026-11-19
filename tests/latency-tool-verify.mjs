/**
 * clash_latency 工具验证（简化：用全局捕获）。
 *
 * 跑法：node tests/latency-tool-verify.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(HERE)

// 全局捕获容器（mock 与验证脚本共享）
globalThis.__capturedTools = []

const src = fs.readFileSync(path.join(ROOT, 'lib', 'tools.js'), 'utf8')
const mocked = src.replace(
  "import { defineTool } from '@deepseek-ai/dsh-tools'",
  "const defineTool = (def, execute) => { globalThis.__capturedTools.push({ name: def.name, def, execute }); return { ...def } }",
)
const mockFile = path.join(ROOT, 'lib', '_tools_mock.mjs')
fs.writeFileSync(mockFile, mocked, 'utf8')

try {
  const { registerTools } = await import(pathToFileURL(mockFile).href)
  const scoped = {
    tools: { register() { return () => {} } },
    effect(fn) { const d = fn(); return () => {} },
    get() { return undefined },
  }
  registerTools(scoped, { configOf: () => JSON.parse(fs.readFileSync(path.join(ROOT, 'defaults.json'), 'utf8')), paths: {} })

  const captured = globalThis.__capturedTools
  console.log('=== 捕获的工具 ===')
  for (const c of captured) console.log(`   ${c.name}  execute=${typeof c.execute}`)

  const lat = captured.find(c => c.name === 'clash_latency')
  if (!lat || typeof lat.execute !== 'function') {
    console.log('✘ clash_latency 的 execute 未捕获')
    process.exit(1)
  }

  console.log('\n=== execute 真跑 ===')
  const result = await lat.execute({ top: 5 })
  console.log(`  ok: ${result.ok}  elapsed: ${result.elapsed}ms`)
  console.log(`  fastest: ${result.fastest}`)
  console.log(`  entries: ${result.entries.length}`)
  for (const e of result.entries.slice(0, 5)) {
    console.log(`    ${e.delay}ms ${e.name.slice(0, 36)}`)
  }

  console.log('\n=== render 输出 ===')
  console.log(lat.def.output.render({}, result))
} finally {
  fs.rmSync(mockFile, { force: true })
}
