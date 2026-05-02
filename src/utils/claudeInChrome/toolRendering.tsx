import * as React from 'react'
import { MessageResponse } from '../../components/MessageResponse.js'
import { supportsHyperlinks } from '../../ink/supports-hyperlinks.js'
import { Link, Text } from '../../ink.js'
import { renderToolResultMessage as renderDefaultMCPToolResultMessage } from '../../tools/MCPTool/UI.js'
import type { MCPToolResult } from '../../utils/mcpValidation.js'
import { truncateToWidth } from '../format.js'
// @ts-ignore
import { trackClaudeInChromeTabId } from './common.js'
export type { Tool } from '@modelcontextprotocol/sdk/types.js'

/**
 * @ant/claude-for-chrome-mcp 中 BROWSER_TOOLS 的所有工具名。
 * 请与该包的 BROWSER_TOOLS 数组保持同步。
 */
export type ChromeToolName =
  | 'javascript_tool'
  | 'read_page'
  | 'find'
  | 'form_input'
  | 'computer'
  | 'navigate'
  | 'resize_window'
  | 'gif_creator'
  | 'upload_image'
  | 'get_page_text'
  | 'tabs_context_mcp'
  | 'tabs_create_mcp'
  | 'update_plan'
  | 'read_console_messages'
  | 'read_network_requests'
  | 'shortcuts_list'
  | 'shortcuts_execute'
const CHROME_EXTENSION_FOCUS_TAB_URL_BASE = 'https://clau.de/chrome/tab/'
function renderChromeToolUseMessage(
  input: Record<string, unknown>,
  toolName: ChromeToolName,
  verbose: boolean,
): React.ReactNode {
  const tabId = input.tabId
  if (typeof tabId === 'number') {
    trackClaudeInChromeTabId(tabId)
  }

  // 根据工具类型和输入构建次要信息
  const secondaryInfo: string[] = []
  switch (toolName) {
    case 'navigate':
      if (typeof input.url === 'string') {
        try {
          const url = new URL(input.url)
          secondaryInfo.push(url.hostname)
        } catch {
          secondaryInfo.push(truncateToWidth(input.url, 30))
        }
      }
      break
    case 'find':
      if (typeof input.query === 'string') {
        secondaryInfo.push(`pattern: ${truncateToWidth(input.query, 30)}`)
      }
      break
    case 'computer':
      if (typeof input.action === 'string') {
        const action = input.action
        if (
          action === 'left_click' ||
          action === 'right_click' ||
          action === 'double_click' ||
          action === 'middle_click'
        ) {
          if (typeof input.ref === 'string') {
            secondaryInfo.push(`${action} on ${input.ref}`)
          } else if (Array.isArray(input.coordinate)) {
            secondaryInfo.push(`${action} at (${input.coordinate.join(', ')})`)
          } else {
            secondaryInfo.push(action)
          }
        } else if (action === 'type' && typeof input.text === 'string') {
          secondaryInfo.push(`type "${truncateToWidth(input.text, 15)}"`)
        } else if (action === 'key' && typeof input.text === 'string') {
          secondaryInfo.push(`key ${input.text}`)
        } else if (action === 'scroll' && typeof input.scroll_direction === 'string') {
          secondaryInfo.push(`scroll ${input.scroll_direction}`)
        } else if (action === 'wait' && typeof input.duration === 'number') {
          secondaryInfo.push(`wait ${input.duration}s`)
        } else if (action === 'left_click_drag') {
          secondaryInfo.push('drag')
        } else {
          secondaryInfo.push(action)
        }
      }
      break
    case 'gif_creator':
      if (typeof input.action === 'string') {
        secondaryInfo.push(`${input.action}`)
      }
      break
    case 'resize_window':
      if (typeof input.width === 'number' && typeof input.height === 'number') {
        secondaryInfo.push(`${input.width}x${input.height}`)
      }
      break
    case 'read_console_messages':
      if (typeof input.pattern === 'string') {
        secondaryInfo.push(`pattern: ${truncateToWidth(input.pattern, 20)}`)
      }
      if (input.onlyErrors === true) {
        secondaryInfo.push('errors only')
      }
      break
    case 'read_network_requests':
      if (typeof input.urlPattern === 'string') {
        secondaryInfo.push(`pattern: ${truncateToWidth(input.urlPattern, 20)}`)
      }
      break
    case 'shortcuts_execute':
      if (typeof input.shortcutId === 'string') {
        secondaryInfo.push(`shortcut_id: ${input.shortcutId}`)
      }
      break
    case 'javascript_tool':
      // verbose 模式下展示完整代码
      if (verbose && typeof input.text === 'string') {
        return input.text
      }
      // 非 verbose 模式下返回空字符串以保持 View Tab 布局
      return ''
    case 'tabs_create_mcp':
    case 'tabs_context_mcp':
    case 'form_input':
    case 'shortcuts_list':
    case 'read_page':
    case 'upload_image':
    case 'get_page_text':
    case 'update_plan':
      // 这些工具没有有意义的次要信息可内联展示。
      // 返回空字符串（而非 null）以确保工具表头仍然渲染。
      return ''
  }
  return secondaryInfo.join(', ') || null
}

/**
 * 为 Chrome 中的 Claude MCP 工具渲染可点击的“查看标签页”链接。
 * 以下情况返回 null：
 * - 工具不是 Chrome 中的 Claude MCP 工具
 * - 输入中没有有效的 tabId
 * - 不支持超链接
 */
function renderChromeViewTabLink(input: unknown): React.ReactNode {
  if (!supportsHyperlinks()) {
    return null
  }
  if (typeof input !== 'object' || input === null || !('tabId' in input)) {
    return null
  }
  const tabId =
    typeof input.tabId === 'number'
      ? input.tabId
      : typeof input.tabId === 'string'
        ? parseInt(input.tabId, 10)
        : NaN
  if (isNaN(tabId)) {
    return null
  }
  const linkUrl = `${CHROME_EXTENSION_FOCUS_TAB_URL_BASE}${tabId}`
  return (
    <Text>
      {' '}
      <Link url={linkUrl}>
        <Text color="subtle">[View Tab]</Text>
      </Link>
    </Text>
  )
}

/**
 * Chrome 中的 Claude 工具结果消息的自定义渲染。
 * 对成功结果展示简要摘要。错误将在 is_error 设置时
 * 由默认的 renderToolUseErrorMessage 处理。
 */
export function renderChromeToolResultMessage(
  output: MCPToolResult,
  toolName: ChromeToolName,
  verbose: boolean,
): React.ReactNode {
  if (verbose) {
    return renderDefaultMCPToolResultMessage(output, [], {
      verbose,
    })
  }
  let summary: string | null = null
  switch (toolName) {
    case 'navigate':
      summary = 'Navigation completed'
      break
    case 'tabs_create_mcp':
      summary = 'Tab created'
      break
    case 'tabs_context_mcp':
      summary = 'Tabs read'
      break
    case 'form_input':
      summary = 'Input completed'
      break
    case 'computer':
      summary = 'Action completed'
      break
    case 'resize_window':
      summary = 'Window resized'
      break
    case 'find':
      summary = 'Search completed'
      break
    case 'gif_creator':
      summary = 'GIF action completed'
      break
    case 'read_console_messages':
      summary = 'Console messages retrieved'
      break
    case 'read_network_requests':
      summary = 'Network requests retrieved'
      break
    case 'shortcuts_list':
      summary = 'Shortcuts retrieved'
      break
    case 'shortcuts_execute':
      summary = 'Shortcut executed'
      break
    case 'javascript_tool':
      summary = 'Script executed'
      break
    case 'read_page':
      summary = 'Page read'
      break
    case 'upload_image':
      summary = 'Image uploaded'
      break
    case 'get_page_text':
      summary = 'Page text retrieved'
      break
    case 'update_plan':
      summary = 'Plan updated'
      break
  }
  if (summary) {
    return (
      <MessageResponse height={1}>
        <Text dimColor>{summary}</Text>
      </MessageResponse>
    )
  }
  return null
}

/**
 * 返回单个 `mcp__computer-use__{toolName}` 工具的方法覆盖对象。可通过一次 spread 操作自定义 Chrome 工具的渲染。
 */
export function getClaudeInChromeMCPToolOverrides(toolName: string): {
  userFacingName: (input?: Record<string, unknown>) => string
  renderToolUseMessage: (
    input: Record<string, unknown>,
    options: {
      verbose: boolean
    },
  ) => React.ReactNode
  renderToolUseTag: (input: Partial<Record<string, unknown>>) => React.ReactNode
  renderToolResultMessage: (
    output: string | MCPToolResult,
    progressMessagesForMessage: unknown[],
    options: {
      verbose: boolean
    },
  ) => React.ReactNode
} {
  return {
    userFacingName(_input?: Record<string, unknown>) {
      // 删除部分工具名末尾的 _mcp 后缀
      const displayName = toolName.replace(/_mcp$/, '')
      return `Claude in Chrome[${displayName}]`
    },
    renderToolUseMessage(
      input: Record<string, unknown>,
      {
        verbose,
      }: {
        verbose: boolean
      },
    ): React.ReactNode {
      return renderChromeToolUseMessage(input, toolName as ChromeToolName, verbose)
    },
    renderToolUseTag(input: Partial<Record<string, unknown>>): React.ReactNode {
      return renderChromeViewTabLink(input)
    },
    renderToolResultMessage(
      output: string | MCPToolResult,
      _progressMessagesForMessage: unknown[],
      {
        verbose,
      }: {
        verbose: boolean
      },
    ): React.ReactNode {
      if (!isMCPToolResult(output)) {
        return null
      }
      return renderChromeToolResultMessage(output, toolName as ChromeToolName, verbose)
    },
  }
}
function isMCPToolResult(output: string | MCPToolResult): output is MCPToolResult {
  return typeof output === 'object' && output !== null
}
