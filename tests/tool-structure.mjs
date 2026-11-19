/**
 * 检查 defineTool 注册出来的对象结构（execute 在哪一层）。
 * 跑法：node tests/tool-structure.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.dirname(HERE)

const src = fs.readFileSync(path.join(ROOT, 'lib', 'tools.js'), 'utf8')
const mocked = src.replace(
  "import { defineTool } from '@deepseek-ai/dsh-tools'",
  "const defineTool = (def, execute) => ({ ...def, execute })",
)
const mockFile = path.join(ROOT, 'lib', '_tools_mock.mjs')
fs.writeFileSync(mockFile, mocked, 'utf8')

try {
  const { registerTools } = await import(pathToFileURL(mockFile).href)
  const registered = []
  const scoped = {
    tools: { register(def) { registered.push(def); return () => {} } },
    effect(fn) { const d = fn(); return () => {} },
    get() { return undefined },
  }
  registerTools(scoped, { configOf: () => JSON.parse(fs.readFileSync(path.join(ROOT, 'defaults.json'), 'utf8')), paths: {} })
  const st = registered.find(d => d.name === 'clash_status')
  console.log('  clash_status 顶层键:', Object.keys(st))
  console.log('  execute 类型:', typeof st.execute)
  const out = JSON.stringify(st, null, 1)
  console.log('  对象 JSON 前 400 字：')
  console.log(out.slice(0, 400))
} finally {
  fs.rmSync(mockFile, { force: true })
}
