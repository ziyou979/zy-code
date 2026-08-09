import { describe, expect, test, beforeEach } from 'bun:test'
import type { CompactionResult } from '../../../src/services/compact/compact.js'
import { createCompactBoundaryMessage } from '../../../src/services/messages/constructors.js'
import {
  beginPrecomputedArm,
  clearAllPrecomputed,
  consumePrecomputed,
  makePrefixFingerprint,
  markPrecomputedReady,
  messagesAlignWithPrefix,
  shouldArmPrecomputed,
} from '../../../src/services/compact/precomputedCompact.js'
import { createTestUserMessage } from '../../_helpers/messageFixtures.js'

function fakeResult(): CompactionResult {
  return {
    boundaryMarker: createCompactBoundaryMessage('auto', 100),
    summaryMessages: [],
    attachments: [],
    hookResults: [],
    messagesToKeep: [],
    preCompactTokenCount: 100,
    postCompactTokenCount: 20,
    truePostCompactTokenCount: 20,
  }
}

describe('precomputedCompact', () => {
  beforeEach(() => {
    clearAllPrecomputed()
    process.env.ZY_CODE_PRECOMPUTED_COMPACT = '1'
  })

  test('makePrefixFingerprint 用 leaf+length', () => {
    const msgs = [
      createTestUserMessage('a', { uuid: 'a' }),
      createTestUserMessage('b', { uuid: 'b' }),
    ]
    expect(makePrefixFingerprint(msgs)).toEqual({
      leafUuid: 'b',
      fingerprint: 'b:2',
    })
  })

  test('messagesAlignWithPrefix：新增消息则 mismatch', () => {
    const base = [
      createTestUserMessage('a', { uuid: 'a' }),
      createTestUserMessage('b', { uuid: 'b' }),
    ]
    const fp = makePrefixFingerprint(base)!
    const state = {
      prefixLeafUuid: fp.leafUuid,
      prefixFingerprint: fp.fingerprint,
    }
    expect(messagesAlignWithPrefix(state, base)).toBe(true)
    expect(
      messagesAlignWithPrefix(state, [...base, createTestUserMessage('c', { uuid: 'c' })]),
    ).toBe(false)
  })

  test('arm → ready → consume 成功路径', () => {
    const msgs = [
      createTestUserMessage('a', { uuid: 'a1' }),
      createTestUserMessage('b', { uuid: 'b1' }),
    ]
    const arm = beginPrecomputedArm({
      sessionKey: 's1',
      messages: msgs,
      model: 'test-model',
    })
    expect(arm?.status).toBe('computing')
    expect(markPrecomputedReady('s1', fakeResult())).toBe(true)
    const consumed = consumePrecomputed('s1', msgs, 'test-model')
    expect(consumed?.postCompactTokenCount).toBe(20)
    // 二次 consume 为空
    expect(consumePrecomputed('s1', msgs, 'test-model')).toBeNull()
  })

  test('prefix 变化则 discard', () => {
    const msgs = [createTestUserMessage('a', { uuid: 'a2' })]
    beginPrecomputedArm({ sessionKey: 's2', messages: msgs, model: 'm' })
    markPrecomputedReady('s2', fakeResult())
    const dirty = [...msgs, createTestUserMessage('x', { uuid: 'x' })]
    expect(consumePrecomputed('s2', dirty, 'm')).toBeNull()
  })

  test('model 不匹配 discard', () => {
    const msgs = [createTestUserMessage('a', { uuid: 'a3' })]
    beginPrecomputedArm({ sessionKey: 's3', messages: msgs, model: 'm1' })
    markPrecomputedReady('s3', fakeResult())
    expect(consumePrecomputed('s3', msgs, 'm2')).toBeNull()
  })

  test('门控关闭时 arm 返回 null', () => {
    delete process.env.ZY_CODE_PRECOMPUTED_COMPACT
    const msgs = [createTestUserMessage('a', { uuid: 'a4' })]
    expect(beginPrecomputedArm({ sessionKey: 's4', messages: msgs, model: 'm' })).toBeNull()
  })

  test('shouldArmPrecomputed：位于 arm 带内才为 true', () => {
    process.env.ZY_CODE_PRECOMPUTED_COMPACT = '1'
    const threshold = 100_000
    expect(shouldArmPrecomputed(79_999, threshold)).toBe(false)
    expect(shouldArmPrecomputed(80_000, threshold)).toBe(true)
    expect(shouldArmPrecomputed(99_999, threshold)).toBe(true)
    expect(shouldArmPrecomputed(100_000, threshold)).toBe(false)
  })
})
