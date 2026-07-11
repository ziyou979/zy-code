import type { PromptMessage, ResourceLink } from '@modelcontextprotocol/sdk/types.js'
import type { ContentBlock, ImageSource } from '../../types/llm.js'
import { isEnvDefinedFalsy } from '../../utils/envUtils.js'
import { TelemetrySafeError_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../utils/errors.js'
import { maybeResizeAndDownsampleImageBuffer } from '../../utils/imageResizer.js'
import { logMCPError } from '../../utils/log.js'
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
import { isPersistError, persistToolResult } from '../../utils/toolResultStorage.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import { normalizeNameForMCP } from './normalization.js'

const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

/**
 * 已知 MCP secret 模式的编译正则集（模块级缓存，避免重复编译）。
 */
const SECRET_REDACTION_PATTERNS: ReadonlyArray<RegExp> = [
  // 通用 API 密钥：sk- 前缀（OpenAI、Anthropic 等）
  /\b(?:sk-|pk-)[a-zA-Z0-9_-]{20,}\b/g,
  // Bearer token / Authorization header 值
  /(?:(?:bearer|token|apikey|api_key|secret|password|passwd|auth)\s*[:=]\s*['"]?)[a-zA-Z0-9_.\-/+]{16,}/gi,
  // URL 中嵌入的密码：https://user:password@host
  /(https?:\/\/)[^:@\/\s]+:[^@\/\s]+@/g,
  // PEM 私钥块
  /-----BEGIN\s+(?:RSA|DSA|EC|OPENSSH|PRIVATE)\s+KEY-----[\s\S]*?-----END\s+(?:RSA|DSA|EC|OPENSSH|PRIVATE)\s+KEY-----/g,
  // AWS 访问密钥
  /\b(?:AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16})\b/g,
  // GitHub/GitLab 个人访问令牌
  /\b(?:ghp_|gho_|ghu_|ghs_|ghr_|glpat-)[a-zA-Z0-9_]{36,}\b/g,
  // Slack Bot/Webhook token
  /\b(?:xoxb-|xoxa-|xoxr-|xapp-|hooks\.slack\.com\/services\/)[a-zA-Z0-9/_-]{20,}\b/g,
  // JWT-like token（base64url 三段落）
  /\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/g,
  // 通用 hex 密钥（64+ hex chars = 256+ bit）
  /\b[0-9a-fA-F]{64,}\b/g,
]

/** 敏感字段名列表 — 匹配 JSON 属性路径的末段 */
const SENSITIVE_FIELD_NAMES = new Set([
  'password', 'passwd', 'secret', 'api_key', 'apikey',
  'apiKey', 'api_secret', 'apiSecret', 'access_token',
  'accessToken', 'refresh_token', 'refreshToken',
  'auth_token', 'authToken', 'private_key', 'privateKey',
  'client_secret', 'clientSecret', 'token', 'credentials',
  'aws_secret_access_key', 'awsSecretAccessKey',
  'session_token', 'sessionToken', 'ssh_key', 'sshKey',
])

/**
 * 将字符串中的已知秘密模式替换为 [REDACTED]。
 * 保留前缀（如 `Bearer`、`sk-` 首字符）以便阅读，仅脱敏值部分。
 */
export function redactMCPSecrets(text: string): string {
  let result = text
  for (const pattern of SECRET_REDACTION_PATTERNS) {
    result = result.replace(pattern, (match) => {
      // 保留前缀 6 字符以维持可读性，剩余替换
      if (match.length <= 12) return '[REDACTED]'
      const prefix = match.slice(0, 6)
      return `${prefix}[REDACTED]`
    })
  }
  return result
}

/**
 * 递归遍历 JSON 值，将敏感字段的值替换为 [REDACTED]。
 * 适用于结构化 MCP 输出的字段级脱敏。
 */
export function redactSensitiveFields(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value
  }
  if (Array.isArray(value)) {
    return value.map(redactSensitiveFields)
  }
  if (typeof value === 'object') {
    const obj: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(value)) {
      if (SENSITIVE_FIELD_NAMES.has(key) && (typeof val === 'string' || typeof val === 'number')) {
        obj[key] = '[REDACTED]'
      } else {
        obj[key] = redactSensitiveFields(val)
      }
    }
    return obj
  }
  return value
}

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
          text: redactMCPSecrets(resultContent.text),
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
            text: `${prefix}${redactMCPSecrets(resource.text)}`,
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
  if (value === null) {
    return 'null'
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return '[]'
    }
    return `[${inferCompactSchema(value[0], depth - 1)}]`
  }
  if (typeof value === 'object') {
    if (depth <= 0) {
      return '{...}'
    }
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

/**
 * 对 MCPToolResult 应用脱敏 — 支持 string 和 ContentBlock[] 两种格式。
 */
function redactMcpContent(content: MCPToolResult): MCPToolResult {
  if (!content) {
    return content
  }
  if (typeof content === 'string') {
    return redactMCPSecrets(content)
  }
  return content.map((block) => {
    if (block.type === 'text') {
      return { ...block, text: redactMCPSecrets(block.text) }
    }
    return block
  })
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
    return redactMcpContent(content)
  }

  const sizeEstimateTokens = getContentSizeEstimate(content)

  // 如果大输出文件功能已禁用，回退到旧的截断行为
  if (isEnvDefinedFalsy(process.env.ENABLE_MCP_LARGE_OUTPUT_FILES)) {
    logEvent('zy_mcp_large_result_handled', {
      outcome: 'truncated',
      reason: 'env_disabled',
      sizeEstimateTokens,
    } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
    return redactMcpContent(await truncateMcpContentIfNeeded(content))
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
    return redactMcpContent(await truncateMcpContentIfNeeded(content))
  }

  // 为持久化文件生成唯一 ID（脱敏后持久化，防止敏感信息落入磁盘文件）
  const timestamp = Date.now()
  const persistId = `mcp-${normalizeNameForMCP(name)}-${normalizeNameForMCP(tool)}-${timestamp}`
  const rawContent = typeof content === 'string' ? content : jsonStringify(content, null, 2)
  const redactedContentStr = redactMCPSecrets(rawContent)
  const persistResult = await persistToolResult(redactedContentStr, persistId)

  if (isPersistError(persistResult)) {
    const contentLength = rawContent.length
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
