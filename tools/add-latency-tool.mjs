/**
 * 插入 clash_latency 工具（正确的 defineTool API 形状）。
 *
 * defineTool 的真实 API（照抄 calibrate 块）：
 *   parameters: {...}              输入 schema
 *   output: { schema, render }     输出 schema + 渲染
 *   async execute(args)            元数据属性
 * 闭合为 4 层：对象} + defineTool) + register) + push)
 *
 * 跑法：node tools/add-latency-tool.mjs
 */
import fs from 'node:fs'

const FILE = 'lib/tools.js'
let s = fs.readFileSync(FILE, 'utf8')
if (s.includes('names.latency')) {
  console.log('已有 latency 工具，跳过')
  process.exit(0)
}

// 锚点：calibrate 块的闭合 '})))'  后跟空行和 return
const re = /(\}\)\)+)(\s+)(return \(\) => \{)/
const m = re.exec(s)
if (!m) {
  console.error('找不到插入锚点')
  process.exit(1)
}

const block = `
  /* ---------------- clash_latency ---------------- */
  disposers.push(scoped.tools.register(defineTool({
    name: names.latency,
    description: '对 GLOBAL 组并发测速并按延迟排序。返回最快节点与完整排行，用于找可用节点。',
    parameters: {
      type: 'object',
      properties: {
        top: { type: 'number', description: '只返回前 N 个（默认 10，最大 30）' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          elapsed: { type: 'number' },
          fastest: { type: 'string' },
          entries: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string' },
                delay: { type: 'number' },
              },
              required: ['name', 'delay'],
            },
          },
        },
      },
      render(_args, value) {
        if (!value.ok) return text(\`延迟测试失败：\${value.error}\`)
        const lines = [\`延迟测试（\${value.elapsed}ms，\${value.entries.length} 个节点）\`]
        if (value.fastest) lines.push(\`最快：\${value.fastest}\`)
        lines.push('')
        for (const entry of value.entries.slice(0, 12)) {
          const bar = '█'.repeat(Math.max(1, Math.round((300 - Math.min(entry.delay, 300)) / 20)))
          lines.push(\`  \${String(entry.delay).padStart(5)}ms \${bar} \${entry.name}\`)
        }
        if (value.entries.length > 12) lines.push(\`  …（另有 \${value.entries.length - 12} 个）\`)
        return text(lines.join('\\n'))
      },
    },
    async execute(args) {
      const config = configOf()
      try {
        const resolved = await resolveTarget(config)
        if (resolved.ok !== true) {
          return { ok: false, elapsed: 0, fastest: '', entries: [], error: '控制器不可达' }
        }
        const started = Date.now()
        const testUrl = config.leaks.latencyTestUrl
        const raw = await request(resolved.target, 'GET',
          \`/group/\${encodeURIComponent(config.bypass.selectorGroup)}/delay?url=\${encodeURIComponent(testUrl)}&timeout=2500\`)
        const data = (() => { try { return JSON.parse(raw.text ?? '{}') } catch { return {} } })()
        const infoPatterns = Array.isArray(config.bypass.infoNodePatterns)
          ? config.bypass.infoNodePatterns.map(p => { try { return new RegExp(p, 'i') } catch { return null } }).filter(Boolean)
          : []
        const isInfo = name => infoPatterns.some(re => re.test(name))
        const entries = Object.entries(data)
          .filter(([name, delay]) => typeof delay === 'number' && delay > 0
            && !config.bypass.terminalNames.includes(name) && !isInfo(name))
          .map(([name, delay]) => ({ name, delay }))
          .sort((a, b) => a.delay - b.delay)
        return {
          ok: true,
          elapsed: Date.now() - started,
          fastest: entries[0] ? \`\${entries[0].delay}ms — \${entries[0].name}\` : '',
          entries,
          error: '',
        }
      } catch (error) {
        return { ok: false, elapsed: 0, fastest: '', entries: [], error: String(error.message ?? error) }
      }
    },`

s = s.replace(re, `$1\n${block}\n$3`)
fs.writeFileSync(FILE, s, 'utf8')
console.log('✔ clash_latency 已插入（正确 API 形状）')
