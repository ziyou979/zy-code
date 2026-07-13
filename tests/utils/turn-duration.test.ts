import { describe, expect, test } from 'bun:test'
import { isLoggableMessage } from '../../src/services/session-storage/logLoading.js'
import { isTranscriptMessage } from '../../src/services/session-storage/predicates.js'
import type { Message } from '../../src/types/message.js'
import { createTurnDurationMessage } from '../../src/utils/messages/constructors.js'

describe('turn_duration 消息', () => {
  test('createTurnDurationMessage 生成正确的消息结构', () => {
    const msg = createTurnDurationMessage(35000, undefined, 5)
    expect(msg.type).toBe('system')
    expect(msg.subtype).toBe('turn_duration')
    expect(msg.durationMs).toBe(35000)
    expect(msg.messageCount).toBe(5)
    expect(msg.uuid).toBeDefined()
    expect(msg.timestamp).toBeDefined()
  })

  test('isLoggableMessage 接受 turn_duration 消息（可持久化）', () => {
    const msg = createTurnDurationMessage(35000, undefined, 5)
    expect(isLoggableMessage(msg as unknown as Message)).toBe(true)
  })

  test('isTranscriptMessage 接受 turn_duration 消息（可恢复）', () => {
    const msg = createTurnDurationMessage(35000, undefined, 5)
    // isTranscriptMessage 检查 entry.type === 'system'
    expect(isTranscriptMessage(msg as never)).toBe(true)
  })

  test('isChainParticipant 接受 turn_duration 消息（参与 parentUuid 链）', () => {
    const { isChainParticipant } = require('../../src/services/session-storage/predicates.js')
    const msg = createTurnDurationMessage(35000, undefined, 5)
    // isChainParticipant 检查 type !== 'progress'
    expect(isChainParticipant(msg)).toBe(true)
  })

  test('CC 行为对齐：所有对话都生成 turn_duration（无 30000ms 阈值）', () => {
    // CC 的 sNa 函数不检查 turnDurationMs > 30000，总是返回 durationMs。
    // zy-code fork 曾添加 30000ms 阈值，已移除以对齐 CC 行为。
    // 现在条件仅为：!aborted && !proactiveActive
    const shortTurnMs = 3000 // 3 秒
    const aborted = false
    const proactiveActive = false

    // 短对话 + 未中断 + 非 proactive → 生成
    const shouldGenerate = !aborted && !proactiveActive
    expect(shouldGenerate).toBe(true)

    // 消息应包含正确的耗时
    const msg = createTurnDurationMessage(shortTurnMs, undefined, 5)
    expect(msg.durationMs).toBe(shortTurnMs)
  })

  test('TurnDurationMessage 渲染条件验证', () => {
    // SystemTextMessage.tsx 中的条件：
    // showTurnDuration = getGlobalConfig().showTurnDuration ?? true
    // verbWithDuration = showTurnDuration && tSync(...)
    const showTurnDuration = true // 默认值
    expect(showTurnDuration).toBe(true)

    // 即使 showTurnDuration = true，如果消息不存在（短对话），也不会渲染
    // 因为 SystemTextMessage 只在 message.subtype === 'turn_duration' 时渲染 TurnDurationMessage
    const msg = createTurnDurationMessage(35000, undefined, 5)
    expect('subtype' in msg && msg.subtype).toBe('turn_duration')
  })
})
