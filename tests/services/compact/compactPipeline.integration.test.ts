/**
 * 压缩管道集成：选取 + 格式化 → 进入 API 上下文的最终 summary 消息文本
 *
 * 覆盖用户报告的完整链路：
 * 1. fork/stream 产出「思考草稿 + 真正 summary」多条 assistant
 * 2. 选取正确消息
 * 3. format 剥离标签外 CoT
 * 4. getCompactUserSummaryMessage 生成 post-compact 上下文
 */
import { describe, expect, test } from 'bun:test'
import {
  formatCompactSummary,
  getCompactUserSummaryMessage,
} from '../../../src/services/compact/prompt.js'
import {
  getCompactSummaryText,
  pickCompactSummaryAssistant,
  resolveStreamedCompactAssistant,
} from '../../../src/services/compact/summarySelection.js'
import { createTestAssistantMessage } from '../../_helpers/messageFixtures.js'

/** 模拟摘要 agent 在 thinking 开启时的典型输出序列 */
function buildThinkingPollutedForkMessages() {
  const thinkingOnly = createTestAssistantMessage(
    [
      {
        type: 'thinking',
        thinking: 'I need to summarize the whole conversation carefully...',
        signature: 'sig-1',
      },
    ],
    { uuid: 'fork-1', messageId: 'mid-1' },
  )

  const cotAsText = createTestAssistantMessage(
    [
      {
        type: 'text',
        text: `先在内部过一遍关键点：
用户用 /compact，进度条停在 50%，摘要里混进了思考内容。
我应该输出 analysis 和 summary 标签。`,
      },
    ],
    { uuid: 'fork-2', messageId: 'mid-2' },
  )

  const properSummary = createTestAssistantMessage(
    [
      {
        type: 'thinking',
        thinking: 'structure the 9 sections',
        signature: 'sig-2',
      },
      {
        type: 'text',
        text: `一些多余的开场白

<analysis>
Internal draft checklist...
</analysis>

<summary>
1. Primary Request and Intent:
   Diagnose and fix /compact progress bar and thinking-content leak

2. Key Technical Concepts:
   - compact asymptotic progress (JQu)
   - zQn summary selection

3. Files and Code Sections:
   - src/services/compact/compact.ts
   - src/services/compact/prompt.ts

4. Current Work:
   Implementing fix plan phases 1-3

5. Pending Tasks:
   - unit tests for selection and format
</summary>

（模型有时在这里继续碎碎念）`,
      },
    ],
    { uuid: 'fork-3', messageId: 'mid-3' },
  )

  // 错误的「最后一条」——若只取 last，会把这条当摘要
  const trailingNoise = createTestAssistantMessage(
    [{ type: 'text', text: 'Wait, did I miss the error handling section?' }],
    { uuid: 'fork-4', messageId: 'mid-4' },
  )

  return [thinkingOnly, cotAsText, properSummary, trailingNoise]
}

describe('compact pipeline integration', () => {
  test('fork 多条 assistant：选取 + 格式化后上下文不含思考碎片', () => {
    const messages = buildThinkingPollutedForkMessages()

    // 1) 选取
    const picked = pickCompactSummaryAssistant(messages)
    expect(picked?.uuid).toBe('fork-3')

    const raw = getCompactSummaryText(messages)
    expect(raw).toBeTruthy()
    expect(raw).toContain('<summary>')
    expect(raw).not.toContain('Wait, did I miss')

    // 2) 格式化
    const formatted = formatCompactSummary(raw!)
    expect(formatted).toContain('Diagnose and fix /compact')
    expect(formatted).toContain('zQn summary selection')
    expect(formatted).not.toContain('一些多余的开场白')
    expect(formatted).not.toContain('碎碎念')
    expect(formatted).not.toContain('Internal draft checklist')

    // 3) 进入下一轮 API 的 user summary 消息
    const apiMessage = getCompactUserSummaryMessage(raw!, true, '/path/to/transcript.jsonl')
    expect(apiMessage).toContain('This session is being continued')
    expect(apiMessage).toContain('Diagnose and fix /compact')
    expect(apiMessage).toContain('/path/to/transcript.jsonl')
    expect(apiMessage).toContain('Continue the conversation from where it left off')
    // 污染源
    expect(apiMessage).not.toContain('先在内部过一遍')
    expect(apiMessage).not.toContain('Wait, did I miss')
    expect(apiMessage).not.toContain('碎碎念')
  })

  test('流式累积路径：resolveStreamedCompactAssistant 与格式化一致', () => {
    const messages = buildThinkingPollutedForkMessages().filter(
      (m) => m.type === 'assistant',
    )
    const resolved = resolveStreamedCompactAssistant(messages)
    expect(resolved?.uuid).toBe('fork-3')

    const raw = getCompactSummaryText(messages)!
    const apiMessage = getCompactUserSummaryMessage(raw, false)
    expect(apiMessage).toContain('Primary Request and Intent')
    expect(apiMessage).not.toContain('I need to summarize the whole conversation')
  })

  test('仅最后一条有纯思考 text、无 summary 时：保留 last（无法凭空创造 summary）', () => {
    const onlyCot = [
      createTestAssistantMessage([{ type: 'text', text: 'thinking only draft' }], {
        uuid: 'only',
      }),
    ]
    expect(pickCompactSummaryAssistant(onlyCot)?.uuid).toBe('only')
    // 无标签时 format 尽量原样（已剥 thinking 标签），调用方仍可能得到弱摘要
    const formatted = formatCompactSummary('thinking only draft')
    expect(formatted).toBe('thinking only draft')
  })

  test('回归：旧逻辑 getLast 会选中 trailing noise（本测试锁定新行为）', () => {
    const messages = buildThinkingPollutedForkMessages()
    const last = messages[messages.length - 1]!
    expect(last.uuid).toBe('fork-4')

    // 新逻辑不得等于 last
    expect(pickCompactSummaryAssistant(messages)?.uuid).not.toBe(last.uuid)
    expect(pickCompactSummaryAssistant(messages)?.uuid).toBe('fork-3')
  })
})
