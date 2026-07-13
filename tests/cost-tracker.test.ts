import { beforeEach, describe, expect, test } from 'bun:test'
import { setCostStateForRestore } from '../src/bootstrap/state/cost.js'
import {
  getModelUsage,
  getTotalCost,
  getTotalCostByCurrency,
  reconstructCostStateFromMessages,
  resetCostState,
} from '../src/cost-tracker.js'
import type { TokenUsage } from '../src/types/llm.js'
import { SYNTHETIC_MODEL } from '../src/utils/messages/constants.js'
import { calculateCost, getModelCurrency } from '../src/utils/modelCost.js'
import { createTestAssistantMessage } from './_helpers/messageFixtures.js'

describe('cost-tracker resume restore', () => {
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
})
