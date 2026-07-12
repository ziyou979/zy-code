/**
 * 压缩摘要消息选取（对齐 CC zQn / KQn）
 */
import { describe, expect, test } from 'bun:test'
import {
  getCompactSummaryText,
  pickCompactSummaryAssistant,
  resolveStreamedCompactAssistant,
} from '../../../src/services/compact/summarySelection.js'
import {
  createTestAssistantMessage,
  createTestUserMessage,
} from '../../_helpers/messageFixtures.js'

describe('summarySelection', () => {
  describe('pickCompactSummaryAssistant', () => {
    test('优先选取含 <summary> 的 assistant，即使它不是最后一条', () => {
      const thinkingDraft = createTestAssistantMessage(
        [{ type: 'text', text: '让我先梳理一下对话脉络……\n用户想修 bug' }],
        { uuid: 'asst-thinking', messageId: 'msg-thinking' },
      )
      const withSummary = createTestAssistantMessage(
        [
          {
            type: 'text',
            text: '<analysis>draft</analysis>\n<summary>\n1. Primary Request: fix bug\n</summary>',
          },
        ],
        { uuid: 'asst-summary', messageId: 'msg-summary' },
      )
      const trailingCot = createTestAssistantMessage(
        [{ type: 'text', text: '补充一点思考：或许还要检查测试' }],
        { uuid: 'asst-trailing', messageId: 'msg-trailing' },
      )

      const picked = pickCompactSummaryAssistant([
        createTestUserMessage('compact please'),
        thinkingDraft,
        withSummary,
        trailingCot,
      ])

      expect(picked?.uuid).toBe('asst-summary')
    })

    test('多条含 <summary> 时取最后一条', () => {
      const first = createTestAssistantMessage(
        [{ type: 'text', text: '<summary>old</summary>' }],
        { uuid: 'asst-old', messageId: 'msg-old' },
      )
      const second = createTestAssistantMessage(
        [{ type: 'text', text: '<summary>new</summary>' }],
        { uuid: 'asst-new', messageId: 'msg-new' },
      )

      const picked = pickCompactSummaryAssistant([first, second])
      expect(picked?.uuid).toBe('asst-new')
    })

    test('无 <summary> 时回退到最后一条带 text 的 assistant', () => {
      const a = createTestAssistantMessage([{ type: 'text', text: 'first draft' }], {
        uuid: 'asst-a',
      })
      const b = createTestAssistantMessage([{ type: 'text', text: 'second draft' }], {
        uuid: 'asst-b',
      })

      expect(pickCompactSummaryAssistant([a, b])?.uuid).toBe('asst-b')
    })

    test('跳过 isApiErrorMessage 的 assistant', () => {
      const good = createTestAssistantMessage(
        [{ type: 'text', text: '<summary>ok</summary>' }],
        { uuid: 'asst-good' },
      )
      const err = createTestAssistantMessage([{ type: 'text', text: 'API Error: boom' }], {
        uuid: 'asst-err',
        isApiErrorMessage: true,
      })

      expect(pickCompactSummaryAssistant([good, err])?.uuid).toBe('asst-good')
    })

    test('跳过仅 thinking 块、无 text 的 assistant', () => {
      const thinkingOnly = createTestAssistantMessage(
        [{ type: 'thinking', thinking: 'internal reasoning', signature: 'sig' }],
        { uuid: 'asst-think-only' },
      )
      const withText = createTestAssistantMessage(
        [{ type: 'text', text: '<summary>body</summary>' }],
        { uuid: 'asst-text' },
      )

      expect(pickCompactSummaryAssistant([thinkingOnly, withText])?.uuid).toBe('asst-text')
      expect(pickCompactSummaryAssistant([thinkingOnly])).toBeUndefined()
    })

    test('thinking + text 同条消息时仍可选中（text 含 summary）', () => {
      const mixed = createTestAssistantMessage(
        [
          { type: 'thinking', thinking: 'plan the summary', signature: 'sig' },
          { type: 'text', text: '<summary>\n1. Intent: ship fix\n</summary>' },
        ],
        { uuid: 'asst-mixed' },
      )

      expect(pickCompactSummaryAssistant([mixed])?.uuid).toBe('asst-mixed')
    })

    test('<SUMMARY> 大小写不敏感', () => {
      const msg = createTestAssistantMessage(
        [{ type: 'text', text: '<SUMMARY>caps ok</SUMMARY>' }],
        { uuid: 'asst-caps' },
      )
      expect(pickCompactSummaryAssistant([msg])?.uuid).toBe('asst-caps')
    })

    test('空列表返回 undefined', () => {
      expect(pickCompactSummaryAssistant([])).toBeUndefined()
    })

    test('仅有 user 消息时返回 undefined', () => {
      expect(pickCompactSummaryAssistant([createTestUserMessage('hi')])).toBeUndefined()
    })
  })

  describe('getCompactSummaryText', () => {
    test('从含 summary 的消息提取全部 text 块', () => {
      const msg = createTestAssistantMessage(
        [
          { type: 'thinking', thinking: 'skip me', signature: '' },
          { type: 'text', text: 'prefix ' },
          { type: 'text', text: '<summary>core</summary>' },
        ],
        { uuid: 'asst-multi' },
      )

      const text = getCompactSummaryText([msg])
      expect(text).toContain('prefix')
      expect(text).toContain('<summary>core</summary>')
      expect(text).not.toContain('skip me')
    })

    test('最后一条是思考草稿时仍取带 summary 的文本', () => {
      const withSummary = createTestAssistantMessage(
        [{ type: 'text', text: '<summary>\nPrimary: refactor\n</summary>' }],
        { uuid: 'asst-sum' },
      )
      const trailing = createTestAssistantMessage(
        [{ type: 'text', text: '嗯，我再想想有没有漏掉的点…' }],
        { uuid: 'asst-trail' },
      )

      const text = getCompactSummaryText([withSummary, trailing])
      expect(text).toContain('<summary>')
      expect(text).toContain('Primary: refactor')
      expect(text).not.toContain('再想想')
    })

    test('无可用 text 时返回 null', () => {
      expect(getCompactSummaryText([])).toBeNull()
      expect(
        getCompactSummaryText([
          createTestAssistantMessage([{ type: 'thinking', thinking: 'x', signature: '' }]),
        ]),
      ).toBeNull()
    })
  })

  describe('resolveStreamedCompactAssistant', () => {
    test('最后一条是 API 错误时直接返回错误消息', () => {
      const good = createTestAssistantMessage(
        [{ type: 'text', text: '<summary>ok</summary>' }],
        { uuid: 'good' },
      )
      const err = createTestAssistantMessage([{ type: 'text', text: 'API Error' }], {
        uuid: 'err',
        isApiErrorMessage: true,
      })

      expect(resolveStreamedCompactAssistant([good, err])?.uuid).toBe('err')
    })

    test('正常流：优先含 summary 的消息', () => {
      const draft = createTestAssistantMessage([{ type: 'text', text: 'thinking aloud' }], {
        uuid: 'draft',
      })
      const summary = createTestAssistantMessage(
        [{ type: 'text', text: '<summary>done</summary>' }],
        { uuid: 'sum' },
      )
      const tail = createTestAssistantMessage([{ type: 'text', text: 'extra' }], {
        uuid: 'tail',
      })

      expect(resolveStreamedCompactAssistant([draft, summary, tail])?.uuid).toBe('sum')
    })

    test('空数组返回 undefined', () => {
      expect(resolveStreamedCompactAssistant([])).toBeUndefined()
    })

    test('无 summary 时返回最后一条', () => {
      const a = createTestAssistantMessage([{ type: 'text', text: 'a' }], { uuid: 'a' })
      const b = createTestAssistantMessage([{ type: 'text', text: 'b' }], { uuid: 'b' })
      expect(resolveStreamedCompactAssistant([a, b])?.uuid).toBe('b')
    })
  })
})
