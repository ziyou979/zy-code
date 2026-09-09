import { createMessageNormalizer, normalizeMessages } from '../src/services/messages/normalize.js'
import { createAssistantMessage } from '../src/services/messages/constructors.js'

// 模拟长会话末尾连续追加消息；对照同一实现的缓存和非缓存路径。
const messages = Array.from({ length: 3000 }, (_, i) =>
  createAssistantMessage({
    content: [
      { type: 'text', text: `message ${i}` },
      { type: 'tool_call', id: String(i), name: 'Bash', input: {} },
    ],
  }),
)
for (const [mode, normalize] of [
  ['full', normalizeMessages],
  ['cached', createMessageNormalizer()],
] as const) {
  let previous = normalize(messages)
  const samples: number[] = []
  let reused = 0
  for (let i = 0; i < 30; i++) {
    const next = [...messages, createAssistantMessage({ content: String(i) })]
    const start = performance.now()
    const rows = normalize(next)
    samples.push(performance.now() - start)
    reused = rows.filter((row, index) => row === previous[index]).length
    previous = rows
  }
  samples.sort((a, b) => a - b)
  console.log(
    JSON.stringify({
      mode,
      sourceMessages: messages.length,
      rows: previous.length,
      medianMs: samples[15],
      p95Ms: samples[28],
      reusedRows: reused,
    }),
  )
}
