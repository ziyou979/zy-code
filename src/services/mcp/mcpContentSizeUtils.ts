/**
 * mcpContentSizeUtils.ts
 *
 * 纯函数/纯类型工具：判断 MCP 内容块类型、估算大小、截断字符串。
 * 从 mcpValidation.ts 提取，无 IO、无业务语义。
 */

import type { ContentBlock, ImageBlock, TextBlock } from '../../types/llm.js'
import { roughTokenCountEstimation } from '../tokenEstimation.js'

export const IMAGE_TOKEN_ESTIMATE = 1600

export type MCPToolResult = string | ContentBlock[] | undefined

function isTextBlock(block: ContentBlock): block is TextBlock {
  return block.type === 'text'
}

function isImageBlock(block: ContentBlock): block is ImageBlock {
  return block.type === 'image'
}

export function getContentSizeEstimate(content: MCPToolResult): number {
  if (!content) {
    return 0
  }

  if (typeof content === 'string') {
    return roughTokenCountEstimation(content)
  }

  return content.reduce((total, block) => {
    if (isTextBlock(block)) {
      return total + roughTokenCountEstimation(block.text)
    } else if (isImageBlock(block)) {
      // 图像 token 估算
      return total + IMAGE_TOKEN_ESTIMATE
    }
    return total
  }, 0)
}

export function getMaxMcpOutputChars(maxTokens: number): number {
  return maxTokens * 4
}

export function getTruncationMessage(maxTokens: number): string {
  return `\n\n[OUTPUT TRUNCATED - exceeded ${maxTokens} token limit]

The tool output was truncated. If this MCP server provides pagination or filtering tools, use them to retrieve specific portions of the data. If pagination is not available, inform the user that you are working with truncated output and results may be incomplete.`
}

export function truncateString(content: string, maxChars: number): string {
  if (content.length <= maxChars) {
    return content
  }
  return content.slice(0, maxChars)
}
