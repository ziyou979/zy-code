/**
 * 统一的本地 Tokenizer 模块。
 *
 * 基于 js-tiktoken 实现本地 token 计数，支持多模型家族：
 * - OpenAI GPT-4: cl100k_base
 * - OpenAI GPT-4o/o1/o3: o200k_base
 * - Claude 系列: cl100k_base（近似，误差约 5-10%）
 * - DeepSeek/Qwen/Llama3/GLM-4/Kimi 等: cl100k_base（近似）
 *
 * 对于没有公开 JS tokenizer 的模型，使用 cl100k_base 作为近似编码，
 * 因为大多数现代 LLM 的 BPE 词表大小和分词粒度与 cl100k_base 接近。
 */

import { encodingForModel, getEncoding, type TiktokenModel } from 'js-tiktoken'

// ============================================================================
// 类型定义
// ============================================================================

/** js-tiktoken 支持的编码名称 */
type TiktokenEncoding = 'cl100k_base' | 'o200k_base' | 'p50k_base' | 'r50k_base' | 'gpt2'

/** 编码器实例缓存，避免重复初始化 */
const encoderCache = new Map<TiktokenEncoding, ReturnType<typeof getEncoding>>()

// ============================================================================
// 模型 → 编码映射
// ============================================================================

/**
 * 模型名称前缀 → tiktoken 编码的映射。
 * 按前缀匹配，优先匹配更长的前缀。
 */
const MODEL_PREFIX_TO_ENCODING: Array<[string, TiktokenEncoding]> = [
  // OpenAI 系列 — 精确匹配
  ['gpt-4o', 'o200k_base'],
  ['gpt-4-turbo', 'cl100k_base'],
  ['gpt-4', 'cl100k_base'],
  ['gpt-3.5', 'cl100k_base'],
  ['o1', 'o200k_base'],
  ['o3', 'o200k_base'],
  ['o4', 'o200k_base'],
  ['chatgpt-4o', 'o200k_base'],

  // Claude 系列 — 近似（Claude 的 tokenizer 未公开，cl100k_base 误差约 5-10%）
  ['claude', 'cl100k_base'],

  // DeepSeek — 近似（BBPE 128K 词表，cl100k_base 是最接近的公开编码）
  ['deepseek', 'cl100k_base'],

  // Qwen — 近似（BBPE 151K 词表）
  ['qwen', 'cl100k_base'],

  // Llama 3 — 近似（tiktoken 128K 词表，与 cl100k_base 接近）
  ['llama-3', 'cl100k_base'],
  ['llama3', 'cl100k_base'],
  ['llama-4', 'cl100k_base'],
  ['llama4', 'cl100k_base'],
  ['meta-llama', 'cl100k_base'],

  // GLM-4 / 智谱 — 近似（tiktoken 150K 词表）
  ['glm', 'cl100k_base'],
  ['chatglm', 'cl100k_base'],

  // Kimi / Moonshot — 近似（tiktoken 163K 词表）
  ['moonshot', 'cl100k_base'],
  ['kimi', 'cl100k_base'],

  // MiniMax
  ['minimax', 'cl100k_base'],
  ['abab', 'cl100k_base'],

  // 华为盘古
  ['pangu', 'cl100k_base'],

  // 百度文心
  ['ernie', 'cl100k_base'],

  // 混元
  ['hunyuan', 'cl100k_base'],

  // Gemini — 近似（SentencePiece 256K 词表，差异较大但 cl100k 仍是最佳近似）
  ['gemini', 'cl100k_base'],
  ['gemma', 'cl100k_base'],

  // Mistral
  ['mistral', 'cl100k_base'],
  ['mixtral', 'cl100k_base'],
  ['codestral', 'cl100k_base'],

  // Cohere
  ['command', 'cl100k_base'],
]

/** 默认编码，用于无法识别的模型 */
const DEFAULT_ENCODING: TiktokenEncoding = 'cl100k_base'

// ============================================================================
// 核心函数
// ============================================================================

/**
 * 根据模型名称获取对应的 tiktoken 编码名称。
 */
export function getEncodingForModel(modelName: string): TiktokenEncoding {
  const lowerModel = modelName.toLowerCase()

  // 先尝试 js-tiktoken 内置的模型映射（精确匹配 OpenAI 模型）
  try {
    encodingForModel(lowerModel as TiktokenModel)
    // encodingForModel 成功意味着这是一个已知的 OpenAI 模型
    if (
      lowerModel.includes('gpt-4o') ||
      lowerModel.startsWith('o1') ||
      lowerModel.startsWith('o3') ||
      lowerModel.startsWith('o4') ||
      lowerModel.includes('chatgpt-4o')
    ) {
      return 'o200k_base'
    }
    return 'cl100k_base'
  } catch {
    // 不是 OpenAI 内置模型，走前缀匹配
  }

  for (const [prefix, encoding] of MODEL_PREFIX_TO_ENCODING) {
    if (lowerModel.startsWith(prefix) || lowerModel.includes(prefix)) {
      return encoding
    }
  }

  return DEFAULT_ENCODING
}

/**
 * 获取或创建指定编码的 encoder 实例（带缓存）。
 */
function getEncoder(encoding: TiktokenEncoding): ReturnType<typeof getEncoding> {
  let encoder = encoderCache.get(encoding)
  if (!encoder) {
    encoder = getEncoding(encoding)
    encoderCache.set(encoding, encoder)
  }
  return encoder
}

/**
 * 使用本地 tokenizer 计算文本的 token 数量。
 *
 * @param text - 要计数的文本
 * @param model - 模型名称，用于选择合适的编码
 * @returns token 数量
 */
export function countTokensLocally(text: string, model: string): number {
  if (!text) return 0

  const encoding = getEncodingForModel(model)
  const encoder = getEncoder(encoding)
  return encoder.encode(text).length
}

/**
 * 使用本地 tokenizer 批量计算多段文本的 token 数量。
 * 比多次调用 countTokensLocally 更高效，因为只初始化一次 encoder。
 *
 * @param texts - 要计数的文本数组
 * @param model - 模型名称
 * @returns 总 token 数量
 */
export function countTokensBatchLocally(texts: string[], model: string): number {
  if (texts.length === 0) return 0

  const encoding = getEncodingForModel(model)
  const encoder = getEncoder(encoding)

  let total = 0
  for (const text of texts) {
    if (text) {
      total += encoder.encode(text).length
    }
  }
  return total
}

/**
 * 判断指定模型的本地 tokenizer 是否为精确匹配（而非近似）。
 * 只有 OpenAI 官方模型的编码是精确的，其他模型都是近似。
 */
export function isExactTokenizer(model: string): boolean {
  const lowerModel = model.toLowerCase()
  return (
    lowerModel.startsWith('gpt-') ||
    lowerModel.startsWith('o1') ||
    lowerModel.startsWith('o3') ||
    lowerModel.startsWith('o4') ||
    lowerModel.startsWith('chatgpt-')
  )
}
