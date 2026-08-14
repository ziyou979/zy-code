import { useEffect, useRef } from 'react'
import { logError } from 'src/services/infra/log.js'
import { z } from 'zod/v4'
import type { ConnectedMCPServer, MCPServerConnection } from '../services/mcp/types.js'
import { getConnectedIdeClient } from '../services/ide/ide.js'
import { lazySchema } from '../utils/lazySchema.js'
export type SelectionPoint = {
  line: number
  character: number
}

export type SelectionData = {
  selection: {
    start: SelectionPoint
    end: SelectionPoint
  } | null
  text?: string
  filePath?: string
}

export type IDESelection = {
  lineCount: number
  lineStart?: number
  text?: string
  filePath?: string
}

// 定义选区变化通知 schema
const SelectionChangedSchema = lazySchema(() =>
  z.object({
    method: z.literal('selection_changed'),
    params: z.object({
      selection: z
        .object({
          start: z.object({
            line: z.number(),
            character: z.number(),
          }),
          end: z.object({
            line: z.number(),
            character: z.number(),
          }),
        })
        .nullable()
        .optional(),
      text: z.string().optional(),
      filePath: z.string().optional(),
    }),
  }),
)

/**
 * 直接向 MCP client 注册通知处理器，用于跟踪 IDE 文本选区信息的 hook。
 */
export function useIdeSelection(
  mcpClients: MCPServerConnection[],
  onSelect: (selection: IDESelection) => void,
): void {
  const handlersRegistered = useRef(false)
  const currentIDERef = useRef<ConnectedMCPServer | null>(null)

  useEffect(() => {
    // 从 MCP client 列表中查找 IDE client
    const ideClient = getConnectedIdeClient(mcpClients)

    // IDE client 变化后需要重新注册处理器。将 undefined 规范化为 null，
    // 使 ref 初始值 null 与“未找到 IDE”的 undefined 对齐，避免每次 MCP 更新都误触发重置。
    if (currentIDERef.current !== (ideClient ?? null)) {
      handlersRegistered.current = false
      currentIDERef.current = ideClient || null
      // IDE client 变化时重置选区
      onSelect({
        lineCount: 0,
        lineStart: undefined,
        text: undefined,
        filePath: undefined,
      })
    }

    // 已为当前 IDE 注册处理器，或没有 IDE client 时跳过
    if (handlersRegistered.current || !ideClient) {
      return
    }

    // 选区变化处理函数
    const selectionChangeHandler = (data: SelectionData) => {
      if (data.selection?.start && data.selection?.end) {
        const { start, end } = data.selection
        let lineCount = end.line - start.line + 1
        // 位于行首字符时，不将该行计为选中
        if (end.character === 0) {
          lineCount--
        }
        const selection = {
          lineCount,
          lineStart: start.line,
          text: data.text,
          filePath: data.filePath,
        }

        onSelect(selection)
      }
    }

    // 为 selection_changed 事件注册通知处理器
    ideClient.client.setNotificationHandler(SelectionChangedSchema(), (notification) => {
      if (currentIDERef.current !== ideClient) {
        return
      }

      try {
        // 从通知参数中获取选区数据
        const selectionData = notification.params

        // 处理选区数据，校验必需属性
        if (selectionData.selection?.start && selectionData.selection.end) {
          // 处理选区变化
          selectionChangeHandler(selectionData as SelectionData)
        } else if (selectionData.text !== undefined) {
          // 处理空选区（text 为空字符串）
          selectionChangeHandler({
            selection: null,
            text: selectionData.text,
            filePath: selectionData.filePath,
          })
        }
      } catch (error) {
        logError(error as Error)
      }
    })

    // 标记处理器已注册
    handlersRegistered.current = true

    // MCP client 会管理自身生命周期，此处无需清理
  }, [mcpClients, onSelect])
}
