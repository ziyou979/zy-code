import { beforeEach, describe, expect, test } from 'bun:test'
import { setCostStateForRestore } from '../src/bootstrap/runtime/runtimeContext.js'
import {
  getModelUsage,
  getTotalAPIDuration,
  getTotalCost,
  getTotalCostByCurrency,
  getTotalDuration,
  reconstructCostStateFromMessages,
  resetCostState,
} from '../src/services/cost/costTracker.js'
import type { TokenUsage } from '../src/types/llm.js'
import { SYNTHETIC_MODEL } from '../src/services/messages/constants.js'
import {
  computeTurnTokenUsage,
  createTurnDurationMessage,
  createUserMessage,
} from '../src/services/messages/constructors.js'
import { calculateCost, getModelCurrency } from '../src/services/model/modelCost.js'
import { createTestAssistantMessage } from './_helpers/messageFixtures.js'

describe('costTracker resume restore', () => {
  beforeEach(() => {
    resetCostState()
  })

  test('可从 transcript assistant usage 重建 statusline 计费状态', () => {
    const model = 'gpt-4'
    const usage: TokenUsage = {
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      cacheReadInputTokens: 200_000,
      cacheCreationInputTokens: 100_000,
    }
    const message = createTestAssistantMessage([{ type: 'text', text: 'ok' }])
    message.message.model = model
    message.message.usage = usage

    const restored = reconstructCostStateFromMessages([message])
    expect(restored).toBeDefined()
    if (!restored) {
      throw new Error('expected restored cost state')
    }

    setCostStateForRestore(restored)

    const expectedCost = calculateCost(model, usage)
    const currency = getModelCurrency(model)
    expect(getTotalCost()).toBeCloseTo(expectedCost, 8)
    expect(getTotalCostByCurrency()[currency]).toBeCloseTo(expectedCost, 8)
    expect(getModelUsage()[model]?.inputTokens).toBe(usage.inputTokens)
    expect(getModelUsage()[model]?.outputTokens).toBe(usage.outputTokens)
  })

  test('重建时跳过 synthetic assistant usage', () => {
    const message = createTestAssistantMessage([{ type: 'text', text: 'internal' }])
    message.message.model = SYNTHETIC_MODEL
    message.message.usage = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    }

    expect(reconstructCostStateFromMessages([message])).toBeUndefined()
  })

  test('可从历史消息时间戳与 turn_duration 重建 /cost 历史耗时', () => {
    const userMsg = createUserMessage({ content: [{ type: 'text', text: 'hello' }] })
    userMsg.timestamp = '2026-10-21T10:00:00.000Z'

    const assistantMsg = createTestAssistantMessage([{ type: 'text', text: 'world' }])
    assistantMsg.timestamp = '2026-10-21T10:00:12.000Z'
    assistantMsg.message.model = 'gpt-4'
    assistantMsg.message.usage = {
      inputTokens: 1000,
      outputTokens: 200,
    }

    const turnDurationMsg = createTurnDurationMessage(15_000)
    turnDurationMsg.timestamp = '2026-10-21T10:00:15.000Z'

    const restored = reconstructCostStateFromMessages([userMsg, assistantMsg, turnDurationMsg])
    expect(restored).toBeDefined()
    expect(restored?.totalAPIDuration).toBe(12_000)
    expect(restored?.lastDuration).toBe(15_000)

    setCostStateForRestore(restored!)
    expect(getTotalAPIDuration()).toBe(12_000)
    expect(getTotalDuration()).toBeGreaterThanOrEqual(15_000)
  })

  test('computeTurnTokenUsage 正确汇总当前轮次的 token 总量并对同响应分块去重', () => {
    const userMsg = createUserMessage({ content: [{ type: 'text', text: 'analyze code' }] })
    const block1 = createTestAssistantMessage([{ type: 'thinking', thinking: 'step 1' }])
    block1.message.id = 'msg_turn_1'
    block1.message.model = 'gpt-4'
    block1.message.usage = {
      inputTokens: 2000,
      outputTokens: 500,
      cacheReadInputTokens: 8000,
    }
    // 同一 message.id 的第二个归一化分块不应重复累计
    const block2 = createTestAssistantMessage([{ type: 'text', text: 'done' }])
    block2.message.id = 'msg_turn_1'
    block2.message.model = 'gpt-4'
    block2.message.usage = block1.message.usage

    const summary = computeTurnTokenUsage([userMsg, block1, block2])
    expect(summary).toEqual({
      totalTokens: 10_500,
      inputTokens: 10_000,
      outputTokens: 500,
      cacheReadInputTokens: 8000,
      cacheCreationInputTokens: 0,
      stepCount: 1,
    })
  })
})
