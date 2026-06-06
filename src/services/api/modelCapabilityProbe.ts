// 通过 API 错误响应反向探测模型 thinking 能力。
// 当 API 返回 "thinking not supported" 类错误时，将该模型的 thinking/adaptive_thinking
// 能力动态降级写入运行时缓存，避免后续请求重复触发相同错误。
// 与 ~/.zy/model-capabilities.json 互补：本地白名单优先，API error 用作运行时反向探测。

import { createDebugLog } from '../../utils/debug.js'

const log = createDebugLog('capability-probe')

// thinking 不被支持的错误消息匹配正则（来自 Claude Code 二进制逆向）
const RE_THINKING_NOT_SUPPORTED = /thinking\.type[^a-z]{1,8}(enabled|adaptive)[^]*?not supported/i
const RE_ADAPTIVE_NOT_SUPPORTED = /\b(adaptive) thinking is not supported/i

// 运行时降级表：记录已确认不支持 thinking 的模型
const degradedModels = new Map<string, { thinking: boolean; adaptiveThinking: boolean }>()

function getOrCreate(model: string) {
  let entry = degradedModels.get(model)
  if (!entry) {
    entry = { thinking: true, adaptiveThinking: true }
    degradedModels.set(model, entry)
  }
  return entry
}

/**
 * 从 API 错误中探测模型 thinking 能力并记录降级。
 * 在 isAPIError(error) 确认后调用。
 */
export function probeThinkingFromError(model: string, errorMessage: string): void {
  if (RE_THINKING_NOT_SUPPORTED.test(errorMessage)) {
    const entry = getOrCreate(model)
    // 判断是 adaptive 还是 enabled 被拒绝
    const match = errorMessage.match(RE_THINKING_NOT_SUPPORTED)
    if (match?.[1]?.toLowerCase() === 'adaptive') {
      entry.adaptiveThinking = false
      log(`模型 ${model} 不支持 adaptive thinking（API 错误探测）`)
    } else {
      entry.thinking = false
      entry.adaptiveThinking = false
      log(`模型 ${model} 不支持 thinking（API 错误探测）`)
    }
    return
  }

  if (RE_ADAPTIVE_NOT_SUPPORTED.test(errorMessage)) {
    const entry = getOrCreate(model)
    entry.adaptiveThinking = false
    log(`模型 ${model} 不支持 adaptive thinking（API 错误探测）`)
  }
}

/**
 * 查询运行时降级表：模型是否已确认不支持 thinking。
 * 返回 undefined 表示未探测过（应回退到其他判断机制）。
 */
export function probedModelSupportsThinking(model: string): boolean | undefined {
  const entry = degradedModels.get(model)
  if (!entry) {
    return undefined
  }
  return entry.thinking
}

/**
 * 查询运行时降级表：模型是否已确认不支持 adaptive thinking。
 */
export function probedModelSupportsAdaptiveThinking(model: string): boolean | undefined {
  const entry = degradedModels.get(model)
  if (!entry) {
    return undefined
  }
  return entry.adaptiveThinking
}

/** 仅用于测试 */
export function _resetForTesting(): void {
  degradedModels.clear()
}
