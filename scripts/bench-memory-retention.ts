import { createAssistantMessage } from '../src/services/messages/constructors.js'
import { buildMessageLookups, scopeMessageLookups } from '../src/services/messages/lookups.js'

// 模拟静态消息行保留挂载时的 props；不发送请求，也不复制工具载荷。
// 分别在新进程运行 full/scoped，避免堆高水位影响对照结果。
const mode = process.argv[2] ?? 'scoped'
if (mode !== 'full' && mode !== 'scoped') throw new Error('Expected full or scoped')
const count = Number(process.argv[3] ?? 1000)
if (!Number.isInteger(count) || count < 1 || count > 3000) throw new Error('Expected 1..3000 rows')
const messages = Array.from({ length: count }, (_, i) =>
  createAssistantMessage({
    content: [{ type: 'tool_call', id: String(i), name: 'Bash', input: {} }],
  }),
)
Bun.gc(true)
const before = process.memoryUsage()
const start = performance.now()
const retained = messages.map((message, i) => {
  const history = messages.slice(0, i + 1)
  const lookups = buildMessageLookups(history, history)
  return mode === 'full' ? lookups : scopeMessageLookups(message, lookups)
})
Bun.gc(true)
const after = process.memoryUsage()
console.log(
  JSON.stringify({
    mode,
    rows: count,
    retainedToolEntries: retained.reduce((sum, row) => sum + row.toolUseByToolUseID.size, 0),
    heapDeltaMiB: (after.heapUsed - before.heapUsed) / 1024 / 1024,
    rssMiB: after.rss / 1024 / 1024,
    elapsedMs: performance.now() - start,
  }),
)
