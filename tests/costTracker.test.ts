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
import { anthropicUsageToStandard } from '../src/services/api/conversions/anthropic.js'
import { openAIUsageToStandard } from '../src/services/api/conversions/openai.js'
import { responsesUsageToStandard } from '../src/services/api/conversions/openaiResponses.js'
import {
  googleResponseToStandard,
  googleStreamToStandard,
} from '../src/services/api/conversions/google.js'
import { updateUsage } from '../src/services/api/usageTracker.js'
import { EMPTY_USAGE } from '../src/services/api/emptyUsage.js'
import { agentToolResultSchema } from '../src/services/agent/agentToolResultSchema.js'
import { aggregateAgentUsage } from '../src/services/agent/agentUsage.js'
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

  describe('computeTurnTokenUsage 按协议口径计输入', () => {
    function turnWith(id: string, usage: TokenUsage) {
      const msg = createTestAssistantMessage([{ type: 'text', text: 'ok' }])
      msg.message.id = id
      msg.message.model = 'test-model'
      msg.message.usage = usage
      return msg
    }
    const user = () => createUserMessage({ content: [{ type: 'text', text: 'go' }] })

    test('OpenAI/Responses 含缓存输入只计一次，Anthropic 不含缓存输入加缓存一次', () => {
      const chat = openAIUsageToStandard({
        prompt_tokens: 1000,
        completion_tokens: 10,
        total_tokens: 1010,
        prompt_tokens_details: { cached_tokens: 800 },
      })
      const responses = responsesUsageToStandard({
        input_tokens: 500,
        output_tokens: 5,
        total_tokens: 505,
        input_tokens_details: { cached_tokens: 300 },
        output_tokens_details: { reasoning_tokens: 2 },
      })
      const anthropic = anthropicUsageToStandard({
        input_tokens: 200,
        output_tokens: 20,
        cache_read_input_tokens: 5000,
        cache_creation_input_tokens: 100,
      })
      expect(chat.extras?.inputIncludesCache).toBe(1)
      expect(responses.extras).toEqual({ reasoning_tokens: 2, inputIncludesCache: 1 })
      expect(anthropic.extras?.inputIncludesCache).toBeUndefined()

      const summary = computeTurnTokenUsage([
        user(),
        turnWith('a', anthropic),
        turnWith('b', chat),
        turnWith('c', responses),
      ])
      expect(summary).toMatchObject({
        inputTokens: 1000 + 500 + (200 + 5000 + 100),
        outputTokens: 35,
        cacheReadInputTokens: 6100,
        cacheCreationInputTokens: 100,
        stepCount: 3,
      })
    })

    test('无缓存时不加标记，口径无关', () => {
      const chat = openAIUsageToStandard({
        prompt_tokens: 7,
        completion_tokens: 1,
        total_tokens: 8,
      })
      expect(chat.extras).toBeUndefined()
    })

    test('Google 普通和流式响应保留缓存语义及其他用量元数据', async () => {
      const response = {
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
        usageMetadata: {
          promptTokenCount: 1000,
          candidatesTokenCount: 10,
          thoughtsTokenCount: 5,
          cachedContentTokenCount: 800,
          initialPromptTokenCount: 900,
        },
      }
      const usage = googleResponseToStandard(response, 'custom-model').usage
      expect(usage.extras).toEqual({
        inputIncludesCache: 1,
        thoughtsTokenCount: 5,
        initialPromptTokenCount: 900,
      })
      expect(computeTurnTokenUsage([user(), turnWith('google', usage)])).toMatchObject({
        inputTokens: 1000,
        outputTokens: 15,
        totalTokens: 1015,
      })
      async function* stream() {
        yield response
      }
      let streamed = EMPTY_USAGE
      for await (const event of googleStreamToStandard(stream(), 'custom-model', 'delta')) {
        if (event.type === 'response_delta') {
          streamed = updateUsage(streamed, event.usage)
        }
      }
      expect(streamed.extras).toEqual(usage.extras)
      expect(
        computeTurnTokenUsage([user(), turnWith('google-stream', streamed)])?.inputTokens,
      ).toBe(1000)
    })

    test('AgentTool 结果解析不会丢失缓存计数语义', () => {
      const result = agentToolResultSchema().parse({
        agentId: 'sub',
        content: [],
        totalToolUseCount: 0,
        totalDurationMs: 0,
        totalTokens: 1010,
        usage: {
          inputTokens: 1000,
          outputTokens: 10,
          cacheReadInputTokens: 800,
          extras: { inputIncludesCache: 1 },
        },
      })
      expect(result.usage.extras?.inputIncludesCache).toBe(1)
    })

    test('同步子智能体按自身标记计输入', () => {
      const result = (usage: Record<string, unknown>) =>
        createUserMessage({
          content: [{ type: 'tool_result', toolCallId: 'tc-1', content: 'done' }],
          toolUseResult: { agentId: 'sub', totalTokens: 0, usage },
        })
      const summary = computeTurnTokenUsage([
        user(),
        result({
          inputTokens: 3000,
          outputTokens: 30,
          cacheReadInputTokens: 2000,
          extras: { inputIncludesCache: 1 },
        }),
        result({ inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 900 }),
      ])
      expect(summary?.inputTokens).toBe(3000 + 1000)
      expect(summary?.outputTokens).toBe(40)
      expect(summary?.cacheReadInputTokens).toBe(2900)
    })

    test('子智能体多请求用量全部汇总，同响应分块取最新，父轮不重复计', () => {
      const asst = (blocks: unknown[], id: string, usage: TokenUsage, model = 'm') => {
        const msg = createTestAssistantMessage(blocks, { messageId: id })
        msg.message.model = model
        msg.message.usage = usage
        return msg
      }
      const anthropicFinal = {
        inputTokens: 100,
        outputTokens: 40,
        cacheReadInputTokens: 4000,
        cacheCreationInputTokens: 50,
      }
      const openai = openAIUsageToStandard({
        prompt_tokens: 1000,
        completion_tokens: 20,
        total_tokens: 1020,
        prompt_tokens_details: { cached_tokens: 600 },
      })
      const agentMessages = [
        user(),
        // 同一响应的 thinking 与 tool_call 分块：先到的是早期 usage，后到的为最终 usage
        asst([{ type: 'thinking', thinking: 'plan' }], 'resp_a', {
          ...anthropicFinal,
          outputTokens: 1,
        }),
        asst([{ type: 'tool_call', id: 'tc', name: 'Agent', input: {} }], 'resp_a', anthropicFinal),
        // 保留的嵌套同步 AgentTool 结果
        createUserMessage({
          content: [{ type: 'tool_result', toolCallId: 'tc', content: 'ok' }],
          toolUseResult: {
            agentId: 'nested',
            usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 90 },
          },
        }),
        asst([{ type: 'text', text: 'done' }], 'resp_b', openai),
        asst(
          [{ type: 'text', text: 'x' }],
          'syn',
          { inputTokens: 999, outputTokens: 9 },
          SYNTHETIC_MODEL,
        ),
      ]
      const usage = aggregateAgentUsage(agentMessages)
      expect(usage).toEqual({
        inputTokens: 100 + (1000 - 600) + 10,
        outputTokens: 65,
        cacheReadInputTokens: 4690,
        cacheCreationInputTokens: 50,
      })
      const result = agentToolResultSchema().parse({
        agentId: 'sub',
        content: [],
        totalToolUseCount: 1,
        totalDurationMs: 0,
        totalTokens: 1020,
        usage,
      })
      const summary = computeTurnTokenUsage([
        user(),
        createUserMessage({
          content: [{ type: 'tool_result', toolCallId: 'tc-1', content: 'done' }],
          toolUseResult: result,
        }),
      ])
      // 4150（Anthropic）+ 1000（OpenAI 含缓存）+ 100（嵌套）
      expect(summary?.inputTokens).toBe(5250)
      expect(summary?.outputTokens).toBe(65)
      expect(summary?.cacheReadInputTokens).toBe(4690)
    })
  })
})
