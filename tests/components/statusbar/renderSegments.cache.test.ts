/**
 * statusline cache 模块：命中率口径（OpenAI / Anthropic 两种 input 口径）
 * 与「无缓存活动不显示」。
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import {
  renderStatusbarSegments,
  type StatusbarContext,
} from '../../../src/components/statusbar/renderSegments.js'
import type { ModuleConfig } from '../../../src/components/statusbar/statusbarModuleDefaults.js'
import { setCostStateForRestore } from '../../../src/bootstrap/runtime/runtimeContext.js'
import {
  reconstructCostStateFromMessages,
  resetCostState,
} from '../../../src/services/cost/costTracker.js'
import type { TokenUsage } from '../../../src/types/llm.js'
import { createTestAssistantMessage } from '../../_helpers/messageFixtures.js'

const cacheModule: ModuleConfig = { id: 'cache', visible: true, icon: '⊛', color: 'text' }

function baseCtx(): StatusbarContext {
  return {
    messages: [],
    mainLoopModel: 'claude-sonnet-4-5' as never,
    effortValue: undefined,
    thinkingEnabled: false,
    branch: null,
    gitClean: null,
    memoryRss: 0,
    tokensPerSecond: null,
    avgTTFTMs: null,
  }
}

/** 通过 transcript 重建路径注入全局累计用量（与 /resume 后状态栏恢复同一路径）。 */
function seedUsages(entries: readonly { model: string; usage: TokenUsage }[]): void {
  const messages = entries.map(({ model, usage }) => {
    const msg = createTestAssistantMessage([{ type: 'text', text: 'ok' }])
    msg.message.model = model
    msg.message.usage = usage
    return msg
  })
  const state = reconstructCostStateFromMessages(messages)
  if (!state) {
    throw new Error('expected reconstructed cost state')
  }
  setCostStateForRestore(state)
}

describe('statusline cache segment', () => {
  beforeEach(() => {
    resetCostState()
  })

  test('OpenAI 口径：prompt_tokens 已含 cached_tokens，不重复计数', () => {
    // 1000 输入中 800 命中 → 80%
    seedUsages([
      {
        model: 'test-model',
        usage: {
          inputTokens: 1000,
          outputTokens: 10,
          cacheReadInputTokens: 800,
          cacheCreationInputTokens: 0,
        },
      },
    ])
    const segs = renderStatusbarSegments([cacheModule], baseCtx())
    expect(segs).toHaveLength(1)
    expect(segs[0]!.text).toBe('⊛ 80%')
  })

  test('Anthropic 口径：input_tokens 不含缓存，分母取缓存总量兜底', () => {
    // 200 非缓存输入 + 5000 命中 + 100 写入：max(200, 5100) = 5100 → 98%
    // （Anthropic 侧是非缓存小头的下界近似，不会超过 100%）
    seedUsages([
      {
        model: 'test-model',
        usage: {
          inputTokens: 200,
          outputTokens: 10,
          cacheReadInputTokens: 5000,
          cacheCreationInputTokens: 100,
        },
      },
    ])
    const segs = renderStatusbarSegments([cacheModule], baseCtx())
    expect(segs[0]!.text).toBe('⊛ 98%')
  })

  test('跨模型累计后再算命中率', () => {
    seedUsages([
      {
        model: 'model-a',
        usage: {
          inputTokens: 1000,
          outputTokens: 10,
          cacheReadInputTokens: 500,
          cacheCreationInputTokens: 0,
        },
      },
      {
        model: 'model-b',
        usage: {
          inputTokens: 1000,
          outputTokens: 10,
          cacheReadInputTokens: 900,
          cacheCreationInputTokens: 0,
        },
      },
    ])
    // 累计命中 1400 / 总输入 2000 → 70%
    const segs = renderStatusbarSegments([cacheModule], baseCtx())
    expect(segs[0]!.text).toBe('⊛ 70%')
  })

  test('无缓存活动时不显示该段', () => {
    seedUsages([{ model: 'test-model', usage: { inputTokens: 1000, outputTokens: 10 } }])
    expect(renderStatusbarSegments([cacheModule], baseCtx())).toHaveLength(0)
  })

  test('只有缓存写入、零命中时显示 0%', () => {
    seedUsages([
      {
        model: 'test-model',
        usage: {
          inputTokens: 1000,
          outputTokens: 10,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 300,
        },
      },
    ])
    const segs = renderStatusbarSegments([cacheModule], baseCtx())
    expect(segs[0]!.text).toBe('⊛ 0%')
  })
})
