/**
 * formatCompactSummary / getCompactUserSummaryMessage — 压缩摘要格式化
 */
import { describe, expect, test } from 'bun:test'
import {
  formatCompactSummary,
  getCompactUserSummaryMessage,
} from '../../../src/services/compact/prompt.js'

describe('formatCompactSummary', () => {
  test('有 <summary> 时只保留标签内正文，丢弃标签外 CoT', () => {
    const raw = `让我仔细分析一下这段对话……
用户一开始要求实现登录，后来又改成 OAuth。

<analysis>
chronological notes that should be dropped
</analysis>

<summary>
1. Primary Request and Intent:
   Implement OAuth login

2. Current Work:
   Writing the token exchange handler
</summary>

或许还要补充一点思考……`

    const formatted = formatCompactSummary(raw)

    expect(formatted.startsWith('Summary:')).toBe(true)
    expect(formatted).toContain('Implement OAuth login')
    expect(formatted).toContain('token exchange handler')
    // 标签外思考不得残留
    expect(formatted).not.toContain('让我仔细分析')
    expect(formatted).not.toContain('或许还要补充')
    expect(formatted).not.toContain('chronological notes')
    expect(formatted).not.toContain('<analysis>')
    expect(formatted).not.toContain('<summary>')
  })

  test('无 summary 时剥离 <analysis> 保留其余文本', () => {
    const raw = `<analysis>draft thoughts</analysis>

Actual freeform summary without tags.`

    const formatted = formatCompactSummary(raw)
    expect(formatted).toBe('Actual freeform summary without tags.')
    expect(formatted).not.toContain('draft thoughts')
  })

  test('剥离文本态 <thinking> 标签', () => {
    const raw = `<thinking>secret reasoning</thinking>
Visible summary line.`

    const formatted = formatCompactSummary(raw)
    expect(formatted).toBe('Visible summary line.')
    expect(formatted).not.toContain('secret reasoning')
  })

  test('未闭合 analysis 标签从开标签起丢弃', () => {
    const raw = `Keep this header.

<analysis>
incomplete draft that never closed`

    const formatted = formatCompactSummary(raw)
    expect(formatted).toContain('Keep this header.')
    expect(formatted).not.toContain('incomplete draft')
  })

  test('<SUMMARY> 大小写不敏感', () => {
    const formatted = formatCompactSummary('<SUMMARY>\nHello\n</SUMMARY>')
    expect(formatted).toBe('Summary:\nHello')
  })

  test('折叠多余空行', () => {
    const formatted = formatCompactSummary('<summary>\nA\n\n\n\nB\n</summary>')
    expect(formatted).toBe('Summary:\nA\n\nB')
  })

  test('空字符串返回空', () => {
    expect(formatCompactSummary('')).toBe('')
    expect(formatCompactSummary('   \n  ')).toBe('')
  })

  test('summary 内含章节编号时完整保留', () => {
    const body = `1. Primary Request and Intent:
   Fix compact progress

2. Key Technical Concepts:
   - asymptotic progress
   - zQn selection

3. Pending Tasks:
   - write tests`
    const formatted = formatCompactSummary(`<summary>\n${body}\n</summary>`)
    expect(formatted).toBe(`Summary:\n${body}`)
  })
})

describe('getCompactUserSummaryMessage', () => {
  test('包装 continuation 前缀且使用格式化后的摘要', () => {
    const raw = `thinking aloud before tags

<summary>
1. Primary Request: ship the fix
</summary>`

    const msg = getCompactUserSummaryMessage(raw, false)

    expect(msg).toContain('This session is being continued from a previous conversation')
    expect(msg).toContain('Summary:')
    expect(msg).toContain('Primary Request: ship the fix')
    expect(msg).not.toContain('thinking aloud before tags')
  })

  test('suppressFollowUpQuestions 追加直接续写指令', () => {
    const msg = getCompactUserSummaryMessage('<summary>work</summary>', true)
    expect(msg).toContain('Continue the conversation from where it left off')
    expect(msg).toContain('do not acknowledge the summary')
  })

  test('transcriptPath 注入完整 transcript 路径提示', () => {
    const msg = getCompactUserSummaryMessage(
      '<summary>x</summary>',
      false,
      '/tmp/transcript.jsonl',
    )
    expect(msg).toContain('/tmp/transcript.jsonl')
    expect(msg).toContain('read the full transcript')
  })

  test('recentMessagesPreserved 追加保留说明', () => {
    const msg = getCompactUserSummaryMessage('<summary>x</summary>', false, undefined, true)
    expect(msg).toContain('Recent messages are preserved verbatim.')
  })

  test('污染的 CoT 摘要不会进入后续 API 上下文前缀', () => {
    // 模拟「模型把思考写在 summary 标签外」——这是后续调用污染的主因
    const polluted = `我先在脑子里过一遍：
- 用户改了压缩逻辑
- 需要注意 thinking 块

<summary>
1. Primary Request and Intent:
   Fix /compact thinking leak
2. Current Work:
   Implementing zQn selection
</summary>

另外我还想说……`

    const apiContext = getCompactUserSummaryMessage(polluted, true)

    expect(apiContext).toContain('Fix /compact thinking leak')
    expect(apiContext).toContain('Implementing zQn selection')
    expect(apiContext).not.toContain('我先在脑子里过一遍')
    expect(apiContext).not.toContain('另外我还想说')
  })
})
