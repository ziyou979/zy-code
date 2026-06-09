/**
 * 统一的本地 Tokenizer 模块。
 *
 * 从项目打包的 gzip 压缩 tokenizer 数据加载，使用内置 BPE 引擎
 * 解析（engine.js，从 transformers.js 提取的精简子集）。tokenizer 数据从 HuggingFace 下载，
 * 由 scripts/download-tokenizers.ts 管理更新。
 *
 * 支持的模型家族（精确分词）：
 * - OpenAI: GPT-4, GPT-4o, GPT-3.5
 * - Claude
 * - Qwen 全系列（共用 tokenizer）
 * - DeepSeek-V3 / R1
 * - Llama 3.x / 4.x
 * - GLM-4 / GLM-5
 * - Kimi / Moonshot
 * - MiniMax
 * - Gemini / Gemma
 * - Mistral / Mixtral / Codestral
 * - Cohere Command-R
 *
 * 未覆盖的模型回退到 GPT-4 tokenizer（cl100k_base 等价）。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { PreTrainedTokenizer } from './engine.js'

// ============================================================================
// 类型定义
// ============================================================================

/** Tokenizer key 常量对象，防止拼写错误 */
const TOKENIZER_KEYS = {
  gpt4o: 'gpt4o',
  gpt4: 'gpt4',
  gpt35turbo: 'gpt35turbo',
  claude: 'claude',
  deepseek: 'deepseek',
  qwen: 'qwen',
  llama3: 'llama3',
  glm: 'glm',
  moonshot: 'moonshot',
  minimax: 'minimax',
  gemini: 'gemini',
  gemma: 'gemma',
  mistral: 'mistral',
  cohere: 'cohere',
} as const

type TokenizerKey = (typeof TOKENIZER_KEYS)[keyof typeof TOKENIZER_KEYS]

export type { TokenizerKey }

type Tokenizer = PreTrainedTokenizer

const tokenizerCache = new Map<TokenizerKey, Tokenizer>()

function resolveDataDir(): string {
  // 构建后: dist/tokenizer-data/（import.meta.dir = dist/）
  const bundled = join(import.meta.dir, 'tokenizer-data')
  if (existsSync(bundled)) return bundled
  // 开发环境: src/services/tokenizer/data/（import.meta.dir = src/services/tokenizer/）
  return join(import.meta.dir, 'data')
}

const DATA_DIR = resolveDataDir()

// ============================================================================
// 模型 → tokenizer 数据文件映射
// ============================================================================

const MODEL_PREFIX_TO_TOKENIZER: Array<[string, TokenizerKey]> = [
  ['gpt-4o', TOKENIZER_KEYS.gpt4o],
  ['chatgpt-4o', TOKENIZER_KEYS.gpt4o],
  ['o1', TOKENIZER_KEYS.gpt4o],
  ['o3', TOKENIZER_KEYS.gpt4o],
  ['o4', TOKENIZER_KEYS.gpt4o],
  ['gpt-4-turbo', TOKENIZER_KEYS.gpt4],
  ['gpt-4', TOKENIZER_KEYS.gpt4],
  ['gpt-3.5', TOKENIZER_KEYS.gpt35turbo],
  ['claude', TOKENIZER_KEYS.claude],
  ['deepseek', TOKENIZER_KEYS.deepseek],
  ['qwen', TOKENIZER_KEYS.qwen],
  ['llama-4', TOKENIZER_KEYS.llama3],
  ['llama4', TOKENIZER_KEYS.llama3],
  ['llama-3', TOKENIZER_KEYS.llama3],
  ['llama3', TOKENIZER_KEYS.llama3],
  ['meta-llama', TOKENIZER_KEYS.llama3],
  ['glm', TOKENIZER_KEYS.glm],
  ['chatglm', TOKENIZER_KEYS.glm],
  ['moonshot', TOKENIZER_KEYS.moonshot],
  ['kimi', TOKENIZER_KEYS.moonshot],
  ['minimax', TOKENIZER_KEYS.minimax],
  ['abab', TOKENIZER_KEYS.minimax],
  ['gemini', TOKENIZER_KEYS.gemini],
  ['gemma', TOKENIZER_KEYS.gemma],
  ['mistral', TOKENIZER_KEYS.mistral],
  ['mixtral', TOKENIZER_KEYS.mistral],
  ['codestral', TOKENIZER_KEYS.mistral],
  ['command', TOKENIZER_KEYS.cohere],
  // pangu / ernie / hunyuan 等无专属 tokenizer 的模型走 DEFAULT_TOKENIZER 兜底
]

const DEFAULT_TOKENIZER: TokenizerKey = TOKENIZER_KEYS.gpt4

// ============================================================================
// 核心函数
// ============================================================================

/**
 * 查找匹配的 tokenizer 条目
 */
function findMatchingTokenizer(modelName: string): [string, TokenizerKey] | undefined {
  const lowerModel = modelName.toLowerCase()
  return MODEL_PREFIX_TO_TOKENIZER.find(([prefix]) => lowerModel.includes(prefix))
}

/**
 * 根据模型名称获取对应的 tokenizer 数据文件标识符。
 */
export function getTokenizerKeyForModel(modelName: string): TokenizerKey {
  return findMatchingTokenizer(modelName)?.[1] ?? DEFAULT_TOKENIZER
}

/**
 * 从打包的 gzip 文件加载 tokenizer 实例（带缓存）。
 */
function getTokenizer(tokenizerKey: TokenizerKey): Tokenizer {
  let tokenizer = tokenizerCache.get(tokenizerKey)
  if (!tokenizer) {
    try {
      const jsonGz = readFileSync(join(DATA_DIR, `${tokenizerKey}.tokenizer.json.gz`))
      const configGz = readFileSync(join(DATA_DIR, `${tokenizerKey}.tokenizer_config.json.gz`))
      const tokenizerJSON = JSON.parse(gunzipSync(jsonGz).toString())
      const tokenizerConfig = JSON.parse(gunzipSync(configGz).toString())
      tokenizer = new PreTrainedTokenizer(tokenizerJSON, tokenizerConfig)
      tokenizerCache.set(tokenizerKey, tokenizer)
    } catch (error) {
      throw new Error(
        `Failed to load tokenizer "${tokenizerKey}" from ${DATA_DIR}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }
  return tokenizer
}

/**
 * 使用本地 tokenizer 计算文本的 token 数量。
 * 为每个模型家族加载原生 tokenizer 数据，实现精确计数。
 */
export function countTokensLocally(text: string, model: string): number {
  if (!text) {
    return 0
  }

  const tokenizerKey = getTokenizerKeyForModel(model)
  const tokenizer = getTokenizer(tokenizerKey)
  return tokenizer.encode(text).length
}

/**
 * 使用本地 tokenizer 批量计算多段文本的 token 数量。
 */
export function countTokensBatchLocally(texts: string[], model: string): number {
  if (texts.length === 0) {
    return 0
  }

  const tokenizerKey = getTokenizerKeyForModel(model)
  const tokenizer = getTokenizer(tokenizerKey)

  let total = 0
  for (const text of texts) {
    if (text) {
      total += tokenizer.encode(text).length
    }
  }
  return total
}

/**
 * 判断指定模型的本地 tokenizer 是否为精确匹配。
 * 在映射表中有明确匹配的模型返回 true，仅走 DEFAULT 兜底的返回 false。
 */
export function isExactTokenizer(model: string): boolean {
  return findMatchingTokenizer(model) !== undefined
}
