import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import {
  countMessagesTokensWithAPI,
  roughTokenCountEstimation,
} from '../services/tokenEstimation.js'
import type { ContentBlock, LLMMessage } from '../types/llm.js'
import { compressImageBlock } from './imageResizer.js'
import { logError } from './log.js'

// @deprecated 请直接导入 src/utils/mcpContentSizeUtils.js 中的同名函数/变量
import {
  getContentSizeEstimate,
  getMaxMcpOutputChars,
  getTruncationMessage,
  type MCPToolResult,
  truncateString,
} from './mcpContentSizeUtils.js'

export {
  getContentSizeEstimate,
  getMaxMcpOutputChars,
  getTruncationMessage,
  type MCPToolResult,
  truncateString,
} from './mcpContentSizeUtils.js'

// @deprecated 请直接导入 src/utils/mcpContentSizeUtils.js 中的 IMAGE_TOKEN_ESTIMATE
export { IMAGE_TOKEN_ESTIMATE } from './mcpContentSizeUtils.js'

export const MCP_TOKEN_COUNT_THRESHOLD_FACTOR = 0.5
const DEFAULT_MAX_MCP_OUTPUT_TOKENS = 25000

/**
 * 解析 MCP 输出 token 上限。优先级：
 *   1. MAX_MCP_OUTPUT_TOKENS 环境变量（用户显式覆盖）
 *   2. zy_satin_quoll GrowthBook 特性标志的 `mcp_tool` 键（单位为 token，不是字符 ——
 *      与该映射中 getPersistenceThreshold 读取的其他键不同；
 *      MCP 有自己的上游截断层）
 *   3. 硬编码默认值
 */
export function getMaxMcpOutputTokens(): number {
  const envValue = process.env.MAX_MCP_OUTPUT_TOKENS
  if (envValue) {
    const parsed = parseInt(envValue, 10)
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed
    }
  }
  const overrides = getFeatureValue_CACHED_MAY_BE_STALE<Record<string, number> | null>(
    'zy_satin_quoll',
    {},
  )
  const override = overrides?.mcp_tool
  if (typeof override === 'number' && Number.isFinite(override) && override > 0) {
    return override
  }
  return DEFAULT_MAX_MCP_OUTPUT_TOKENS
}

async function truncateContentBlocks(
  blocks: ContentBlock[],
  maxChars: number,
): Promise<ContentBlock[]> {
  const result: ContentBlock[] = []
  let currentChars = 0

  for (const block of blocks) {
    if (block.type === 'text') {
      const remainingChars = maxChars - currentChars
      if (remainingChars <= 0) {
        break
      }

      if (block.text.length <= remainingChars) {
        result.push(block)
        currentChars += block.text.length
      } else {
        result.push({ type: 'text', text: block.text.slice(0, remainingChars) })
        break
      }
    } else if (block.type === 'image') {
      // 包含图像但计入其估算大小
      const imageChars = 1600 * 4
      if (currentChars + imageChars <= maxChars) {
        result.push(block)
        currentChars += imageChars
      } else {
        // 图像超出预算 - 尝试压缩以适应剩余空间
        const remainingChars = maxChars - currentChars
        if (remainingChars > 0) {
          // 将剩余字符数转换为字节数用于压缩
          // base64 使用约 4/3 倍的原始大小，因此计算最大字节数
          const remainingBytes = Math.floor(remainingChars * 0.75)
          try {
            const compressedBlock = await compressImageBlock(block, remainingBytes)
            result.push(compressedBlock)
            // 根据压缩后的图像大小更新 currentChars
            currentChars += compressedBlock.data?.length ?? imageChars
          } catch {
            // 压缩失败时跳过该图像
          }
        }
      }
    } else {
      result.push(block)
    }
  }

  return result
}

export async function mcpContentNeedsTruncation(content: MCPToolResult): Promise<boolean> {
  if (!content) {
    return false
  }

  // 使用大小检查作为启发式方法，避免不必要的 token 计数 API 调用
  const contentSizeEstimate = getContentSizeEstimate(content)
  if (contentSizeEstimate <= getMaxMcpOutputTokens() * MCP_TOKEN_COUNT_THRESHOLD_FACTOR) {
    return false
  }

  try {
    const messages =
      typeof content === 'string'
        ? [{ role: 'user' as const, content }]
        : [{ role: 'user' as const, content: content as ContentBlock[] }]

    const tokenCount = await countMessagesTokensWithAPI(messages as LLMMessage[], [])
    return !!(tokenCount && tokenCount > getMaxMcpOutputTokens())
  } catch (error) {
    logError(error)
    // 出错时假定不需要截断
    return false
  }
}

export async function truncateMcpContent(content: MCPToolResult): Promise<MCPToolResult> {
  if (!content) {
    return content
  }

  const maxTokens = getMaxMcpOutputTokens()
  const maxChars = getMaxMcpOutputChars(maxTokens)
  const truncationMsg = getTruncationMessage(maxTokens)

  if (typeof content === 'string') {
    return truncateString(content, maxChars) + truncationMsg
  } else {
    const truncatedBlocks = await truncateContentBlocks(content as ContentBlock[], maxChars)
    truncatedBlocks.push({ type: 'text', text: truncationMsg })
    return truncatedBlocks
  }
}

export async function truncateMcpContentIfNeeded(content: MCPToolResult): Promise<MCPToolResult> {
  if (!(await mcpContentNeedsTruncation(content))) {
    return content
  }

  return await truncateMcpContent(content)
}
