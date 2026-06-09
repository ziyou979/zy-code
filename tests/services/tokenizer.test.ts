/**
 * 本地 Tokenizer 模块测试。
 *
 * 验证所有支持的模型家族能正确加载 bundled tokenizer 数据并精确分词。
 * 参考值来源：各模型官方 tokenizer（Python tiktoken / HuggingFace tokenizers）。
 */
import { describe, expect, test } from 'bun:test'
import {
  countTokensLocally,
  countTokensBatchLocally,
  getTokenizerKeyForModel,
  isExactTokenizer,
  type TokenizerKey,
} from '../../src/services/tokenizer/index.js'

// ============================================================================
// 模型前缀 → tokenizer key 映射
// ============================================================================

describe('getTokenizerKeyForModel', () => {
  const cases: Array<[string, string]> = [
    // OpenAI
    ['gpt-4o-2024-08-06', 'gpt4o'],
    ['gpt-4o-mini', 'gpt4o'],
    ['chatgpt-4o-latest', 'gpt4o'],
    ['o1-preview', 'gpt4o'],
    ['o3-mini', 'gpt4o'],
    ['o4-mini', 'gpt4o'],
    ['gpt-4-turbo-2024-04-09', 'gpt4'],
    ['gpt-4-0613', 'gpt4'],
    ['gpt-3.5-turbo', 'gpt35turbo'],
    // Claude
    ['claude-3.5-sonnet-20241022', 'claude'],
    ['claude-sonnet-4-20250514', 'claude'],
    ['claude-opus-4-20250514', 'claude'],
    // DeepSeek
    ['deepseek-chat', 'deepseek'],
    ['deepseek-reasoner', 'deepseek'],
    // Qwen
    ['qwen3-plus', 'qwen'],
    ['qwen3.5-flash', 'qwen'],
    ['qwen3.6-plus', 'qwen'],
    ['qwen2.5-72b-instruct', 'qwen'],
    ['qwen-max', 'qwen'],
    // Llama
    ['llama-3.1-70b', 'llama3'],
    ['llama3-8b', 'llama3'],
    ['llama-4-maverick', 'llama3'],
    ['meta-llama/Meta-Llama-3-8B', 'llama3'],
    // GLM
    ['glm-4-plus', 'glm'],
    ['chatglm3-6b', 'glm'],
    // Moonshot / Kimi
    ['moonshot-v1-8k', 'moonshot'],
    ['kimi-k2', 'moonshot'],
    // MiniMax
    ['minimax-text-01', 'minimax'],
    ['abab6.5-chat', 'minimax'],
    // Gemini / Gemma
    ['gemini-2.5-pro', 'gemini'],
    ['gemma-3-1b-it', 'gemma'],
    // Mistral
    ['mistral-large-latest', 'mistral'],
    ['mixtral-8x22b', 'mistral'],
    ['codestral-2405', 'mistral'],
    // Cohere
    ['command-r-plus', 'cohere'],
    // Fallback
    ['pangu-pro', 'gpt4'],
    ['ernie-4.5-8k', 'gpt4'],
    ['hunyuan-turbos', 'gpt4'],
    ['some-unknown-model', 'gpt4'],
  ]

  test.each(cases)('%s → %s', (model, expected) => {
    expect(getTokenizerKeyForModel(model)).toBe(expected as TokenizerKey)
  })
})

// ============================================================================
// isExactTokenizer
// ============================================================================

describe('isExactTokenizer', () => {
  test('已覆盖的模型返回 true', () => {
    const covered = [
      'gpt-4o', 'gpt-4', 'gpt-3.5-turbo',
      'claude-3.5-sonnet', 'qwen3-plus', 'deepseek-chat',
      'llama-3.1-70b', 'glm-4-plus', 'moonshot-v1',
      'minimax-text-01', 'gemini-2.5-pro', 'gemma-3-1b',
      'mistral-large', 'command-r-plus',
    ]
    for (const model of covered) {
      expect(isExactTokenizer(model)).toBe(true)
    }
  })

  test('未覆盖的模型返回 false', () => {
    expect(isExactTokenizer('some-unknown-model')).toBe(false)
    expect(isExactTokenizer('pangu-pro')).toBe(false)
  })
})

// ============================================================================
// countTokensLocally — 边界情况
// ============================================================================

describe('countTokensLocally', () => {
  test('空字符串返回 0', () => {
    expect(countTokensLocally('', 'gpt-4o')).toBe(0)
  })

  test('空模型名使用默认 tokenizer', () => {
    const count = countTokensLocally('hello world', '')
    expect(count).toBeGreaterThan(0)
  })

  test('不同模型对相同文本返回不同 token 数', () => {
    const text = '你好世界 Hello World'
    const results = new Map<string, number>()
    const models = ['gpt-4o', 'claude-3.5-sonnet', 'qwen3-plus', 'llama-3.1-70b', 'gemini-2.5-pro']
    for (const model of models) {
      results.set(model, countTokensLocally(text, model))
    }
    const uniqueCounts = new Set(results.values())
    expect(uniqueCounts.size).toBeGreaterThan(1)
  })
})

// ============================================================================
// countTokensBatchLocally
// ============================================================================

describe('countTokensBatchLocally', () => {
  test('空数组返回 0', () => {
    expect(countTokensBatchLocally([], 'gpt-4o')).toBe(0)
  })

  test('批量计数等于逐个计数之和', () => {
    const texts = ['Hello world', '你好世界', 'foo bar baz']
    const model = 'qwen3-plus'
    const batchCount = countTokensBatchLocally(texts, model)
    const sumCount = texts.reduce((sum, t) => sum + countTokensLocally(t, model), 0)
    expect(batchCount).toBe(sumCount)
  })

  test('包含空字符串不影响计数', () => {
    const model = 'gpt-4o'
    const withEmpty = countTokensBatchLocally(['hello', '', 'world'], model)
    const withoutEmpty = countTokensBatchLocally(['hello', 'world'], model)
    expect(withEmpty).toBe(withoutEmpty)
  })
})

// ============================================================================
// 精确性验证 — 与官方 tokenizer 参考值对比
// ============================================================================

describe('精确性验证', () => {
  // 参考值来源：各模型的 Python 官方 tokenizer
  // 生成方式：tiktoken.encode() / tokenizers.Tokenizer.encode()

  const fixtures: Array<{
    model: string
    text: string
    expected: number
    label: string
  }> = [
    // -- 英文 --
    { model: 'gpt-4o', text: 'Hello, world!', expected: 4, label: 'GPT-4o 英文短句' },
    { model: 'gpt-4', text: 'Hello, world!', expected: 4, label: 'GPT-4 英文短句' },
    { model: 'claude-3.5-sonnet', text: 'Hello, world!', expected: 4, label: 'Claude 英文短句' },

    // -- 中文 --
    { model: 'gpt-4o', text: '你好世界', expected: 2, label: 'GPT-4o 中文' },
    { model: 'qwen3-plus', text: '你好世界', expected: 2, label: 'Qwen 中文' },
    { model: 'deepseek-chat', text: '你好世界', expected: 2, label: 'DeepSeek 中文' },

    // -- 混合 --
    { model: 'gpt-4o', text: '你好世界 Hello World', expected: 4, label: 'GPT-4o 中英混合' },
    { model: 'qwen3-plus', text: '你好世界 Hello World', expected: 4, label: 'Qwen 中英混合' },
    { model: 'claude-3.5-sonnet', text: '你好世界 Hello World', expected: 7, label: 'Claude 中英混合' },
    { model: 'llama-3.1-70b', text: '你好世界 Hello World', expected: 6, label: 'Llama3 中英混合' },
    { model: 'moonshot-v1', text: '你好世界 Hello World', expected: 4, label: 'Moonshot 中英混合' },
    { model: 'gemini-2.5-pro', text: '你好世界 Hello World', expected: 5, label: 'Gemini 中英混合' },

    // -- 代码 --
    {
      model: 'gpt-4o',
      text: 'function hello() { return "world"; }',
      expected: 9,
      label: 'GPT-4o 代码',
    },
    {
      model: 'deepseek-chat',
      text: 'function hello() { return "world"; }',
      expected: 9,
      label: 'DeepSeek 代码',
    },

    // -- 长文本一致性 --
    {
      model: 'qwen3-plus',
      text: '大语言模型（LLM）是一种基于深度学习的自然语言处理技术，能够理解和生成人类语言。',
      expected: 23,
      label: 'Qwen 中文长句',
    },
  ]

  test.each(fixtures)('$label: "$text" → $expected tokens', ({ model, text, expected }) => {
    expect(countTokensLocally(text, model)).toBe(expected)
  })
})

// ============================================================================
// tokenizer 缓存验证
// ============================================================================

describe('tokenizer 缓存', () => {
  test('同一模型多次调用返回一致结果', () => {
    const text = '缓存一致性测试 cache consistency'
    const model = 'qwen3-plus'
    const first = countTokensLocally(text, model)
    const second = countTokensLocally(text, model)
    const third = countTokensLocally(text, model)
    expect(first).toBe(second)
    expect(second).toBe(third)
  })
})
