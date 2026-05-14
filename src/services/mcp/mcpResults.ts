import type { ImageSource, ContentBlock } from '../../types/llm.js'
import type { PromptMessage, ResourceLink } from '@modelcontextprotocol/sdk/types.js'
import { normalizeNameForMCP } from './normalization.js'
import { maybeResizeAndDownsampleImageBuffer } from '../../utils/imageResizer.js'
import {
  getBinaryBlobSavedMessage,
  getFormatDescription,
  getLargeOutputInstructions,
  persistBinaryContent,
} from '../../utils/mcpOutputStorage.js'
import {
  getContentSizeEstimate,
  type MCPToolResult,
  mcpContentNeedsTruncation,
  truncateMcpContentIfNeeded,
} from '../../utils/mcpValidation.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { logMCPError } from '../../utils/log.js'
import { TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../utils/errors.js'
import { isEnvDefinedFalsy } from '../../utils/envUtils.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import { isPersistError, persistToolResult } from '../../utils/toolResultStorage.js'

const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

/**
 * Transform result content from an MCP tool or MCP prompt into message blocks
 */
export async function transformResultContent(
  resultContent: PromptMessage['content'],
  serverName: string,
): Promise<Array<ContentBlock>> {
  switch (resultContent.type) {
    case 'text':
      return [
        {
          type: 'text',
          text: resultContent.text,
        },
      ]
    case 'audio': {
      const audioData = resultContent as {
        type: 'audio'
        data: string
        mimeType?: string
      }
      return await persistBlobToTextBlock(
        Buffer.from(audioData.data, 'base64'),
        audioData.mimeType,
        serverName,
        `[Audio from ${serverName}] `,
      )
    }
    case 'image': {
      // 调整并压缩图像数据，强制应用 API 尺寸限制
      const imageBuffer = Buffer.from(String(resultContent.data), 'base64')
      const ext = resultContent.mimeType?.split('/')[1] || 'png'
      const resized = await maybeResizeAndDownsampleImageBuffer(
        imageBuffer,
        imageBuffer.length,
        ext,
      )
      return [
        {
          type: 'image',
          mimeType: `image/${resized.mediaType}` as ImageSource['mediaType'],
          data: resized.buffer.toString('base64'),
        },
      ]
    }
    case 'resource': {
      const resource = resultContent.resource
      const prefix = `[Resource from ${serverName} at ${resource.uri}] `

      if ('text' in resource) {
        return [
          {
            type: 'text',
            text: `${prefix}${resource.text}`,
          },
        ]
      } else if ('blob' in resource) {
        const isImage = IMAGE_MIME_TYPES.has(resource.mimeType ?? '')

        if (isImage) {
          // 调整并压缩图像 blob，强制应用 API 尺寸限制
          const imageBuffer = Buffer.from(resource.blob, 'base64')
          const ext = resource.mimeType?.split('/')[1] || 'png'
          const resized = await maybeResizeAndDownsampleImageBuffer(
            imageBuffer,
            imageBuffer.length,
            ext,
          )
          const content: ContentBlock[] = []
          if (prefix) {
            content.push({
              type: 'text',
              text: prefix,
            })
          }
          content.push({
            type: 'image',
            mimeType: `image/${resized.mediaType}` as ImageSource['mediaType'],
            data: resized.buffer.toString('base64'),
          })
          return content
        } else {
          return await persistBlobToTextBlock(
            Buffer.from(resource.blob, 'base64'),
            resource.mimeType,
            serverName,
            prefix,
          )
        }
      }
      return []
    }
    case 'resource_link': {
      const resourceLink = resultContent as ResourceLink
      let text = `[Resource link: ${resourceLink.name}] ${resourceLink.uri}`
      if (resourceLink.description) {
        text += ` (${resourceLink.description})`
      }
      return [
        {
          type: 'text',
          text,
        },
      ]
    }
    default:
      return []
  }
}

/**
 * Decode base64 binary content, write it to disk with the proper extension,
 * and return a small text block with the file path.
 */
async function persistBlobToTextBlock(
  bytes: Buffer,
  mimeType: string | undefined,
  serverName: string,
  sourceDescription: string,
): Promise<Array<ContentBlock>> {
  const persistId = `mcp-${normalizeNameForMCP(serverName)}-blob-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const result = await persistBinaryContent(bytes, mimeType, persistId)

  if ('error' in result) {
    return [
      {
        type: 'text',
        text: `${sourceDescription}Binary content (${mimeType || 'unknown type'}, ${bytes.length} bytes) could not be saved to disk: ${result.error}`,
      },
    ]
  }

  return [
    {
      type: 'text',
      text: getBinaryBlobSavedMessage(result.filepath, mimeType, result.size, sourceDescription),
    },
  ]
}

/**
 * Processes MCP tool result into a normalized format.
 */
export type MCPResultType = 'toolResult' | 'structuredContent' | 'contentArray'

export type TransformedMCPResult = {
  content: MCPToolResult
  type: MCPResultType
  schema?: string
}

/**
 * Generates a compact, jq-friendly type signature for a value.
 * e.g. "{title: string, items: [{id: number, name: string}]}"
 */
export function inferCompactSchema(value: unknown, depth = 2): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    return `[${inferCompactSchema(value[0], depth - 1)}]`
  }
  if (typeof value === 'object') {
    if (depth <= 0) return '{...}'
    const entries = Object.entries(value).slice(0, 10)
    const props = entries.map(([k, v]) => `${k}: ${inferCompactSchema(v, depth - 1)}`)
    const suffix = Object.keys(value).length > 10 ? ', ...' : ''
    return `{${props.join(', ')}${suffix}}`
  }
  return typeof value
}

export async function transformMCPResult(
  result: unknown,
  tool: string,
  name: string,
): Promise<TransformedMCPResult> {
  if (result && typeof result === 'object') {
    if ('toolResult' in result) {
      return {
        content: String(result.toolResult),
        type: 'toolResult',
      }
    }

    if ('structuredContent' in result && result.structuredContent !== undefined) {
      return {
        content: jsonStringify(result.structuredContent),
        type: 'structuredContent',
        schema: inferCompactSchema(result.structuredContent),
      }
    }

    if ('content' in result && Array.isArray(result.content)) {
      const transformedContent = (
        await Promise.all(result.content.map((item) => transformResultContent(item, name)))
      ).flat()
      return {
        content: transformedContent,
        type: 'contentArray',
        schema: inferCompactSchema(transformedContent),
      }
    }
  }

  const errorMsg = `MCP server "${name}" tool "${tool}": unexpected response format`
  logMCPError(name, errorMsg)
  throw new TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS(
    errorMsg,
    'MCP tool unexpected response format',
  )
}

/**
 * Check if MCP content contains any image blocks.
 */
function contentContainsImages(content: MCPToolResult): boolean {
  if (!content || typeof content === 'string') {
    return false
  }
  return content.some((block) => block.type === 'image')
}

export async function processMCPResult(
  result: unknown,
  tool: string,
  name: string,
): Promise<MCPToolResult> {
  const { content, type, schema } = await transformMCPResult(result, tool, name)

  // IDE 工具不会直接发送给模型，所以不需要处理大输出。
  if (name === 'ide') {
    return content
  }

  // 检查内容是否需要截断（即是否太大）
  if (!(await mcpContentNeedsTruncation(content))) {
    return content
  }

  const sizeEstimateTokens = getContentSizeEstimate(content)

  // 如果大输出文件功能已禁用，回退到旧的截断行为
  if (isEnvDefinedFalsy(process.env.ENABLE_MCP_LARGE_OUTPUT_FILES)) {
    logEvent('zy_mcp_large_result_handled', {
      outcome: 'truncated',
      reason: 'env_disabled',
      sizeEstimateTokens,
    } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
    return await truncateMcpContentIfNeeded(content)
  }

  if (!content) {
    return content
  }

  // 如果内容包含图像，回退到截断
  if (contentContainsImages(content)) {
    logEvent('zy_mcp_large_result_handled', {
      outcome: 'truncated',
      reason: 'contains_images',
      sizeEstimateTokens,
    } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
    return await truncateMcpContentIfNeeded(content)
  }

  // 为持久化文件生成唯一 ID
  const timestamp = Date.now()
  const persistId = `mcp-${normalizeNameForMCP(name)}-${normalizeNameForMCP(tool)}-${timestamp}`
  const contentStr = typeof content === 'string' ? content : jsonStringify(content, null, 2)
  const persistResult = await persistToolResult(contentStr, persistId)

  if (isPersistError(persistResult)) {
    const contentLength = contentStr.length
    logEvent('zy_mcp_large_result_handled', {
      outcome: 'truncated',
      reason: 'persist_failed',
      sizeEstimateTokens,
    } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
    return `Error: result (${contentLength.toLocaleString()} characters) exceeds maximum allowed tokens. Failed to save output to file: ${persistResult.error}. If this MCP server provides pagination or filtering tools, use them to retrieve specific portions of the data.`
  }

  logEvent('zy_mcp_large_result_handled', {
    outcome: 'persisted',
    reason: 'file_saved',
    sizeEstimateTokens,
    persistedSizeChars: persistResult.originalSize,
  } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)

  const formatDescription = getFormatDescription(type, schema)
  return getLargeOutputInstructions(
    persistResult.filepath,
    persistResult.originalSize,
    formatDescription,
  )
}
