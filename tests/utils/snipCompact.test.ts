/**
 * snipCompact 功能单元测试
 * 运行: bun test tests/utils/snipCompact.test.ts
 */

import { describe, test, expect } from 'bun:test'
import {
  isSnipRuntimeEnabled,
  isSnipMarkerMessage,
  shouldNudgeForSnips,
  shouldSnip,
  snipMessages,
  snipCompactIfNeeded,
} from '../../src/services/compact/snipCompact.js'
import {
  isSnipBoundaryMessage,
  projectSnippedView,
} from '../../src/services/compact/snipProjection.js'
import type { Message } from '../../src/types/message.js'

// ---- Mock helpers ----
function makeUser(text: string): Message {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    isMeta: false,
    timestamp: new Date().toISOString(),
    uuid: crypto.randomUUID(),
  } as Message
}

function makeAssistant(text: string): Message {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      id: `msg_${crypto.randomUUID()}`,
    },
    isMeta: false,
    timestamp: new Date().toISOString(),
    uuid: crypto.randomUUID(),
  } as Message
}

function makeSystem(text: string): Message {
  return {
    type: 'system',
    subtype: 'away_summary',
    content: text,
    isMeta: false,
    timestamp: new Date().toISOString(),
    uuid: crypto.randomUUID(),
  }
}

// 构造小消息列表（≤ 4 轮）
const smallMsgs = [makeSystem('preamble'), makeUser('hi'), makeAssistant('hello')]

// 构造大消息列表（6 轮 user+assistant）
function buildLargeMsgs(): Message[] {
  const messages: Message[] = [makeSystem('system prompt preamble')]
  for (let i = 1; i <= 6; i++) {
    messages.push(makeUser(`question ${i}`))
    messages.push(makeAssistant(`answer ${i}`))
  }
  return messages
}

describe('snipCompact', () => {
  describe('isSnipRuntimeEnabled', () => {
    test('返回 true', () => {
      expect(isSnipRuntimeEnabled()).toBe(true)
    })
  })

  describe('shouldNudgeForSnips', () => {
    test('空消息列表返回 false', () => {
      expect(shouldNudgeForSnips([])).toBe(false)
    })

    test('单条短消息返回 false', () => {
      expect(shouldNudgeForSnips([makeUser('hi')])).toBe(false)
    })
  })

  describe('shouldSnip', () => {
    test('空消息列表返回 false', () => {
      expect(shouldSnip([])).toBe(false)
    })
  })

  describe('snipMessages', () => {
    test('小列表（≤ MIN_KEEP）不变', () => {
      expect(snipMessages(smallMsgs).length).toBe(smallMsgs.length)
    })

    test('大列表会被裁剪', () => {
      const largeMsgs = buildLargeMsgs()
      const snipped = snipMessages(largeMsgs)
      expect(snipped.length).toBeLessThan(largeMsgs.length)
      expect(snipped.length).toBeGreaterThan(0)
    })

    test('裁剪结果包含 snip_boundary 消息', () => {
      const snipped = snipMessages(buildLargeMsgs())
      const hasBoundary = snipped.some(
        (m) => m.type === 'system' && (m as { subtype?: string }).subtype === 'snip_boundary',
      )
      expect(hasBoundary).toBe(true)
    })

    test('裁剪结果保留 preamble（system 消息）', () => {
      const snipped = snipMessages(buildLargeMsgs())
      const preamblePreserved = snipped.some(
        (m) => m.type === 'system' && (m as { subtype?: string }).subtype !== 'snip_boundary',
      )
      expect(preamblePreserved).toBe(true)
    })

    test('boundary 位于 preamble 之后', () => {
      const snipped = snipMessages(buildLargeMsgs())
      const boundaryIdx = snipped.findIndex(
        (m) => m.type === 'system' && (m as { subtype?: string }).subtype === 'snip_boundary',
      )
      expect(boundaryIdx).toBeGreaterThan(0)
    })
  })

  describe('snipCompactIfNeeded', () => {
    test('空消息列表 → tokensFreed=0', () => {
      const result = snipCompactIfNeeded([])
      expect(result.tokensFreed).toBe(0)
      expect(result.messages.length).toBe(0)
    })

    test('force:true 对小列表不会报错', () => {
      const result = snipCompactIfNeeded(smallMsgs, { force: true })
      const hasBoundary = result.messages.some(
        (m) => m.type === 'system' && (m as { subtype?: string }).subtype === 'snip_boundary',
      )
      expect(result.messages.length >= smallMsgs.length || hasBoundary).toBe(true)
    })

    test('force:true 对大列表释放 token', () => {
      const result = snipCompactIfNeeded(buildLargeMsgs(), { force: true })
      expect(result.tokensFreed).toBeGreaterThan(0)
      expect(result.boundaryMessage).toBeDefined()
    })

    test('小列表不带 force 不会裁剪', () => {
      const result = snipCompactIfNeeded(smallMsgs)
      expect(result.tokensFreed).toBe(0)
    })
  })

  describe('isSnipBoundaryMessage', () => {
    test('识别 snip_boundary', () => {
      expect(isSnipBoundaryMessage({ type: 'system', subtype: 'snip_boundary' })).toBe(true)
    })

    test('拒绝非 boundary 的 system 消息', () => {
      expect(isSnipBoundaryMessage({ type: 'system', subtype: 'init' })).toBe(false)
    })

    test('拒绝 user 消息', () => {
      expect(isSnipBoundaryMessage({ type: 'user' })).toBe(false)
    })
  })

  describe('projectSnippedView', () => {
    test('有 boundary 时投影视图更短', () => {
      const projectedMsgs: Message[] = [
        makeSystem('old preamble'),
        makeUser('old question'),
        makeAssistant('old answer'),
        {
          type: 'system',
          subtype: 'snip_boundary',
          content: '--- snipped ---',
          isMeta: false,
          timestamp: new Date().toISOString(),
          uuid: crypto.randomUUID(),
        } as Message,
        makeUser('new question'),
        makeAssistant('new answer'),
      ]
      const projected = projectSnippedView(projectedMsgs)
      expect(projected.length).toBeLessThan(projectedMsgs.length)
      expect(projected.length).toBeGreaterThan(0)
    })

    test('投影视图首条消息是 snip_boundary', () => {
      const projectedMsgs: Message[] = [
        makeSystem('old preamble'),
        makeUser('old question'),
        {
          type: 'system',
          subtype: 'snip_boundary',
          content: '--- snipped ---',
          isMeta: false,
          timestamp: new Date().toISOString(),
          uuid: crypto.randomUUID(),
        } as Message,
        makeUser('new question'),
      ]
      const projected = projectSnippedView(projectedMsgs)
      expect(projected[0]?.type).toBe('system')
      expect((projected[0] as { subtype?: string }).subtype).toBe('snip_boundary')
    })

    test('无 boundary 时列表不变', () => {
      expect(projectSnippedView(smallMsgs).length).toBe(smallMsgs.length)
    })
  })

  describe('isSnipMarkerMessage', () => {
    test('识别 snip_marker', () => {
      expect(isSnipMarkerMessage({ type: 'system', subtype: 'snip_marker' })).toBe(true)
    })

    test('拒绝 snip_boundary', () => {
      expect(isSnipMarkerMessage({ type: 'system', subtype: 'snip_boundary' })).toBe(false)
    })

    test('拒绝 user 消息', () => {
      expect(isSnipMarkerMessage({ type: 'user' })).toBe(false)
    })
  })
})
