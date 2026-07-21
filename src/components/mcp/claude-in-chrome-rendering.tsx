import * as React from 'react'
import { MessageResponse } from '../MessageResponse.js'
import { supportsHyperlinks } from '../../ink/supportsHyperlinks.js'
import { Link, Text } from '../../ink/index.js'
import { tSync } from '../../i18n/index.js'
import { renderToolResultMessage as renderDefaultMCPToolResultMessage } from '../../tools/MCPTool/UI.js'
import { truncateToWidth } from '../../utils/format.js'
import type { MCPToolResult } from '../../services/mcp/mcpValidation.js'
import { trackClaudeInChromeTabId } from '../../services/claude-in-chrome/common.js'

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
        secondaryInfo.push(
          tSync('chromeRendering.pattern', { query: truncateToWidth(input.query, 30) }),
        )
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
            secondaryInfo.push(tSync('chromeRendering.actionOn', { action, ref: input.ref }))
          } else if (Array.isArray(input.coordinate)) {
            secondaryInfo.push(
              tSync('chromeRendering.actionAt', {
                action,
                coordinate: input.coordinate.join(', '),
              }),
            )
          } else {
            secondaryInfo.push(tSync('chromeRendering.action', { action }))
          }
        } else if (action === 'type' && typeof input.text === 'string') {
          secondaryInfo.push(
            tSync('chromeRendering.type', { text: truncateToWidth(input.text, 15) }),
          )
        } else if (action === 'key' && typeof input.text === 'string') {
          secondaryInfo.push(tSync('chromeRendering.key', { keyName: input.text }))
        } else if (action === 'scroll' && typeof input.scroll_direction === 'string') {
          secondaryInfo.push(tSync('chromeRendering.scroll', { direction: input.scroll_direction }))
        } else if (action === 'wait' && typeof input.duration === 'number') {
          secondaryInfo.push(tSync('chromeRendering.wait', { duration: input.duration }))
        } else if (action === 'left_click_drag') {
          secondaryInfo.push(tSync('chromeRendering.drag'))
        } else {
          secondaryInfo.push(tSync('chromeRendering.action', { action }))
        }
      }
      break
    case 'gif_creator':
      if (typeof input.action === 'string') {
        secondaryInfo.push(tSync('chromeRendering.action', { action: input.action }))
      }
      break
    case 'resize_window':
      if (typeof input.width === 'number' && typeof input.height === 'number') {
        secondaryInfo.push(`${input.width}x${input.height}`)
      }
      break
    case 'read_console_messages':
      if (typeof input.pattern === 'string') {
        secondaryInfo.push(
          tSync('chromeRendering.pattern', { query: truncateToWidth(input.pattern, 20) }),
        )
      }
      if (input.onlyErrors === true) {
        secondaryInfo.push(tSync('chromeRendering.errorsOnly'))
      }
      break
    case 'read_network_requests':
      if (typeof input.urlPattern === 'string') {
        secondaryInfo.push(
          tSync('chromeRendering.pattern', { query: truncateToWidth(input.urlPattern, 20) }),
        )
      }
      break
    case 'shortcuts_execute':
      if (typeof input.shortcutId === 'string') {
        secondaryInfo.push(tSync('chromeRendering.shortcutId', { shortcutId: input.shortcutId }))
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
  if (Number.isNaN(tabId)) {
    return null
  }
  const linkUrl = `${CHROME_EXTENSION_FOCUS_TAB_URL_BASE}${tabId}`
  return (
    <Text>
      {' '}
      <Link url={linkUrl}>
        <Text color="subtle">{tSync('chromeRendering.viewTab')}</Text>
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
      summary = tSync('chromeRendering.summaryNavigation')
      break
    case 'tabs_create_mcp':
      summary = tSync('chromeRendering.summaryTabCreated')
      break
    case 'tabs_context_mcp':
      summary = tSync('chromeRendering.summaryTabsRead')
      break
    case 'form_input':
      summary = tSync('chromeRendering.summaryInputCompleted')
      break
    case 'computer':
      summary = tSync('chromeRendering.summaryActionCompleted')
      break
    case 'resize_window':
      summary = tSync('chromeRendering.summaryWindowResized')
      break
    case 'find':
      summary = tSync('chromeRendering.summarySearchCompleted')
      break
    case 'gif_creator':
      summary = tSync('chromeRendering.summaryGifCompleted')
      break
    case 'read_console_messages':
      summary = tSync('chromeRendering.summaryConsoleRetrieved')
      break
    case 'read_network_requests':
      summary = tSync('chromeRendering.summaryNetworkRetrieved')
      break
    case 'shortcuts_list':
      summary = tSync('chromeRendering.summaryShortcutsRetrieved')
      break
    case 'shortcuts_execute':
      summary = tSync('chromeRendering.summaryShortcutExecuted')
      break
    case 'javascript_tool':
      summary = tSync('chromeRendering.summaryScriptExecuted')
      break
    case 'read_page':
      summary = tSync('chromeRendering.summaryPageRead')
      break
    case 'upload_image':
      summary = tSync('chromeRendering.summaryImageUploaded')
      break
    case 'get_page_text':
      summary = tSync('chromeRendering.summaryPageTextRetrieved')
      break
    case 'update_plan':
      summary = tSync('chromeRendering.summaryPlanUpdated')
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
      return tSync('chromeRendering.userFacingName', { displayName })
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
