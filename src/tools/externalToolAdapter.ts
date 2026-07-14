/**
 * 外部工具适配器。
 *
 * 将用户在 ~/.zy/tools/ 下定义的简化工具定义
 * 包装为完整的内部 Tool 类型，通过 buildTool() 填充所有默认值。
 */
import React from 'react'
import { z } from 'zod/v4'
import { MessageResponse } from '../components/MessageResponse.js'
import { Box, Text } from '../ink.js'
import { buildTool, type ToolInputJSONSchema } from '../tool.js'
import type { PermissionResult } from '../types/permissions.js'
import { errorMessage } from '../utils/errors.js'
import { lazySchema } from '../utils/lazySchema.js'
import { jsonStringify } from '../utils/slowOperations.js'
import { isOutputLineTruncated } from '../terminal-ui/terminal.js'

/**
 * 用户定义的外部工具接口（简化版）。
 * 用户只需实现核心字段，adaptExternalTool() 填充其余默认值。
 */
export interface ExternalToolDefinition {
  /** 工具名称，必须唯一（建议加前缀如 ext__xxx 避免与内置工具冲突） */
  name: string
  /** 工具描述（纯字符串） */
  description: string
  /** JSON Schema 格式的输入定义 */
  inputSchema: ToolInputJSONSchema
  /** 工具执行函数，返回字符串或可序列化对象 */
  call(args: Record<string, unknown>): Promise<string | Record<string, unknown>>
  /** 是否启用（默认 true，设为 false 可快捷关闭此工具） */
  enabled?: boolean
  /** 是否只读（默认 true，安全优先） */
  isReadOnly?: boolean
  /** ToolSearch 搜索关键词提示 */
  searchHint?: string
  /**
   * 用户可读的入参展示。
   * 函数接收原始入参，返回简短展示文本。返回 null 时回退到默认 key=value 格式。
   */
  userFacingInput?: (input: Record<string, unknown>) => string | null
  /**
   * 用户可读的出参展示。
   * 函数接收 call() 的输出文本，返回展示文本（支持多行）。返回 null 时回退到原始输出。
   */
  userFacingOutput?: (output: string) => string | null
}

// 外部工具通用 inputSchema：允许任意字段透传
const externalInputSchema = lazySchema(() => z.object({}).passthrough())

/**
 * 将用户的简化工具定义适配为完整的内部 Tool。
 */
export function adaptExternalTool(def: ExternalToolDefinition) {
  const isReadOnly = def.isReadOnly ?? true

  return buildTool({
    name: def.name,
    searchHint: def.searchHint,
    maxResultSizeChars: 100_000,

    get inputSchema() {
      return externalInputSchema()
    },
    inputJSONSchema: def.inputSchema,

    async description() {
      return def.description
    },
    async prompt() {
      return def.description
    },

    isReadOnly: () => isReadOnly,
    isConcurrencySafe: () => isReadOnly,

    // 外部工具必须经过用户权限确认（与 MCP 工具一致）
    async checkPermissions(): Promise<PermissionResult> {
      return {
        behavior: 'passthrough',
        message: `External tool "${def.name}" requires permission.`,
        suggestions: [
          {
            type: 'addRules' as const,
            rules: [{ toolName: def.name, ruleContent: undefined }],
            behavior: 'allow' as const,
            destination: 'localSettings' as const,
          },
        ],
      }
    },

    async call(args: Record<string, unknown>) {
      try {
        const result = await def.call(args)
        const data = typeof result === 'string' ? result : jsonStringify(result, null, 2)
        return { data }
      } catch (error) {
        return { data: `External tool "${def.name}" failed: ${errorMessage(error)}` }
      }
    },

    mapToolResultToToolResultBlock(content: string, toolUseID: string) {
      return {
        toolCallId: toolUseID,
        type: 'tool_result' as const,
        content,
      }
    },

    renderToolUseMessage(input: Partial<Record<string, unknown>>) {
      // 优先使用用户自定义的入参展示
      if (def.userFacingInput) {
        const text = def.userFacingInput(input as Record<string, unknown>)
        if (text != null) {
          return React.createElement(Text, null, text)
        }
      }

      // 注意：UI 框架（AssistantToolUseMessage.tsx）已在标签中渲染了工具名称，
      // 此处只应展示参数预览，不重复包含 def.name
      const argsPreview = Object.entries(input)
        .map(([key, value]) => `${key}=${typeof value === 'string' ? value : jsonStringify(value)}`)
        .join(', ')
      if (!argsPreview) {
        return null
      }
      return React.createElement(
        Text,
        { dimColor: true },
        argsPreview.length > 120 ? `${argsPreview.slice(0, 117)}...` : argsPreview,
      )
    },

    renderToolResultMessage(
      output: string,
      _progressMessages: unknown[],
      { verbose }: { verbose: boolean },
    ) {
      if (!output) {
        return null
      }

      // 优先使用用户自定义的出参展示
      if (def.userFacingOutput) {
        const text = def.userFacingOutput(output)
        if (text != null) {
          return React.createElement(
            Box,
            { flexDirection: 'column' },
            React.createElement(MessageResponse, {
              height: 1,
              children: React.createElement(Text, null, text),
            }),
          )
        }
      }

      const displayText = !verbose && output.length > 500 ? `${output.slice(0, 497)}...` : output
      return React.createElement(
        Box,
        { flexDirection: 'column' },
        React.createElement(MessageResponse, {
          height: 1,
          children: React.createElement(Text, null, displayText),
        }),
      )
    },

    isResultTruncated(output: string): boolean {
      // toolUseResult 在消息回放（/resume）时可能是非字符串类型，
      // typeof 守卫防止 content.indexOf 崩溃
      return typeof output === 'string' && isOutputLineTruncated(output)
    },

    userFacingName: () => def.name,
  })
}
