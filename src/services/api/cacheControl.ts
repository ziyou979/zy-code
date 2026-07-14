import {
  getDefaultAdvancedModel,
  getDefaultCompactModel,
  getDefaultStandardModel,
} from '../model/model.js'
import type { TextBlock } from '../../types/llm.js'
import { splitSysPromptPrefix } from '../../utils/api.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { getModelPromptCachingMode } from '../settings/localModelCapabilities.js'
import { getInitialSettings } from '../settings/settings.js'
import type { SystemPrompt } from '../../utils/systemPromptType.js'

export function getPromptCachingEnabled(model: string): boolean {
  // 全局禁用优先
  if (isEnvTruthy(process.env.DISABLE_PROMPT_CACHING)) {
    return false
  }

  // 检查是否应对 compact 模型禁用
  if (isEnvTruthy(process.env.DISABLE_PROMPT_CACHING_HAIKU)) {
    const compactModel = getDefaultCompactModel()
    if (model === compactModel) {
      return false
    }
  }

  // 检查是否应对 standard 模型禁用
  if (isEnvTruthy(process.env.DISABLE_PROMPT_CACHING_SONNET)) {
    const standardModel = getDefaultStandardModel()
    if (model === standardModel) {
      return false
    }
  }

  // 检查是否应对 advanced 模型禁用
  if (isEnvTruthy(process.env.DISABLE_PROMPT_CACHING_OPUS)) {
    const advancedModel = getDefaultAdvancedModel()
    if (model === advancedModel) {
      return false
    }
  }

  // 隐式缓存模型不需要客户端发送 cache_control 标记
  if (getModelPromptCachingMode(model) === 'implicit') {
    return false
  }

  return true
}

/**
 * 返回通用的缓存控制标识。
 *
 * 通用设计：返回 `{ type: 'ephemeral' }` 加上从配置读取的可选 TTL。
 * 所有支持缓存的 provider（Anthropic、百炼、火山、OpenAI 等）都能识别。
 *
 * TTL 通过 `settings.promptCacheTTL` 配置，可选 '5m' 或 '1h'，
 * 适用于 Anthropic 和 OpenAI API。
 */
export function getCacheControl(): { type: 'ephemeral'; ttl?: '5m' | '1h' } {
  const settings = getInitialSettings()
  const ttl = settings.promptCacheTTL

  return {
    type: 'ephemeral',
    ...(ttl && { ttl }),
  }
}

export function buildSystemPromptBlocks(
  systemPrompt: SystemPrompt,
  enablePromptCaching: boolean,
): TextBlock[] {
  // 静态块 + 动态块各一个 cache breakpoint（共 2 个），加上消息层 1 个，共 3/4
  return splitSysPromptPrefix(systemPrompt).map((block) => {
    return {
      type: 'text' as const,
      text: block.text,
      ...(enablePromptCaching && block.shouldCache && { cache_control: getCacheControl() }),
    }
  })
}
