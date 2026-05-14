import figures from 'figures'
import type { RefObject } from 'react'
import React, { useCallback, useMemo, useRef } from 'react'
import { Box, Text } from '../ink.js'
import { useKeybindings } from '../keybindings/useKeybinding.js'
import { logEvent } from '../services/analytics/index.js'
import type { NormalizedUserMessage, RenderableMessage } from '../types/message.js'
import { isEmptyMessageText, SYNTHETIC_MESSAGES } from '../utils/messages.js'
const NAVIGABLE_TYPES = [
  'user',
  'assistant',
  'grouped_tool_use',
  'collapsed_read_search',
  'system',
  'attachment',
] as const
export type NavigableType = (typeof NAVIGABLE_TYPES)[number]
export type NavigableOf<T extends NavigableType> = Extract<
  RenderableMessage,
  {
    type: T
  }
>
export type NavigableMessage = RenderableMessage

// 第二级黑名单（第一级是 height > 0）——渲染但不可操作的内容。
export function isNavigableMessage(msg: NavigableMessage): boolean {
  switch (msg.type) {
    case 'assistant': {
      const b = msg.message.content[0]
      // 文本回复（减去 AssistantTextMessage 的 return-null 情况——第一级
      // 错过未测量的虚拟项目），或具有可提取输入的工具调用。
      return (
        (b &&
          b.type === 'text' &&
          !isEmptyMessageText(b.text) &&
          !SYNTHETIC_MESSAGES.has(b.text)) ||
        (b && b.type === 'tool_call' && b.name in PRIMARY_INPUT)
      )
    }
    case 'user': {
      if (msg.isMeta || msg.isCompactSummary) return false
      const b = msg.message.content[0] as any
      if (b?.type !== 'text') return false
      // 中断等——合成的，不是用户创作的。
      if (SYNTHETIC_MESSAGES.has((b as any).text)) return false
      // 与 VirtualMessageList sticky-prompt 相同的过滤器：XML 包装的
      //（命令扩展、bash 输出等）不是真正的提示。
      return !stripSystemReminders((b as any).text).startsWith('<')
    }
    case 'system':
      // biome-ignore lint/nursery/useExhaustiveSwitchCases: blocklist — fallthrough return-true is the design
      switch (msg.subtype) {
        case 'stop_hook_summary':
        case 'turn_duration':
        case 'memory_saved':
        case 'agents_killed':
        case 'away_summary':
        case 'thinking' as any:
          return false
      }
      return true
    case 'grouped_tool_use':
    case 'collapsed_read_search':
      return true
    case 'attachment':
      switch (msg.attachment.type) {
        case 'queued_command':
        case 'diagnostics':
        case 'hook_blocking_error':
        case 'hook_error_during_execution':
          return true
      }
      return false
  }
}
type PrimaryInput = {
  label: string
  extract: (input: Record<string, unknown>) => string | undefined
}
const str = (k: string) => (i: Record<string, unknown>) =>
  typeof i[k] === 'string' ? i[k] : undefined
const PRIMARY_INPUT = {
  Read: {
    label: 'path',
    extract: str('file_path'),
  },
  Edit: {
    label: 'path',
    extract: str('file_path'),
  },
  Write: {
    label: 'path',
    extract: str('file_path'),
  },
  NotebookEdit: {
    label: 'path',
    extract: str('notebook_path'),
  },
  Bash: {
    label: 'command',
    extract: str('command'),
  },
  Grep: {
    label: 'pattern',
    extract: str('pattern'),
  },
  Glob: {
    label: 'pattern',
    extract: str('pattern'),
  },
  WebFetch: {
    label: 'url',
    extract: str('url'),
  },
  WebSearch: {
    label: 'query',
    extract: str('query'),
  },
  Task: {
    label: 'prompt',
    extract: str('prompt'),
  },
  Agent: {
    label: 'prompt',
    extract: str('prompt'),
  },
  Tmux: {
    label: 'command',
    extract: (i) => (Array.isArray(i.args) ? `tmux ${i.args.join(' ')}` : undefined),
  },
}

// 仅 AgentTool 有 renderGroupedToolUse——Edit/Bash 等保持为 assistant tool_use 块。
export function toolCallOf(msg: NavigableMessage):
  | {
      name: string
      input: Record<string, unknown>
    }
  | undefined {
  if (msg.type === 'assistant') {
    const b = msg.message.content[0]
    if (b && b.type === 'tool_call')
      return {
        name: b.name,
        input: b.input as Record<string, unknown>,
      }
  }
  if (msg.type === 'grouped_tool_use') {
    const b = (msg as any).messages[0]?.message.content[0]
    if (b?.type === 'tool_call')
      return {
        name: (msg as any).toolName,
        input: b.input as Record<string, unknown>,
      }
  }
  return undefined
}
export type MessageActionCaps = {
  copy: (text: string) => void
  edit: (msg: NormalizedUserMessage) => Promise<void>
}

// 标识构建器——保留元组类型，使 `run` 的参数可以窄化（没有这个的话数组字面量会加宽）。
function action<const T extends NavigableType, const K extends string>(a: {
  key: K
  label: string | ((s: MessageActionsState) => string)
  types: readonly T[]
  applies?: (s: MessageActionsState) => boolean
  stays?: true
  run: (m: NavigableOf<T>, caps: MessageActionCaps) => void
}) {
  return a
}
export const MESSAGE_ACTIONS = [
  action({
    key: 'enter',
    label: (s) => (s.expanded ? 'collapse' : 'expand'),
    types: ['grouped_tool_use', 'collapsed_read_search', 'attachment', 'system'],
    stays: true,
    // 空——`stays` 由 dispatch 内联处理。
    run: () => {},
  }),
  action({
    key: 'enter',
    label: 'edit',
    types: ['user'],
    run: (m, c) => void c.edit(m as any),
  }),
  action({
    key: 'c',
    label: 'copy',
    types: NAVIGABLE_TYPES,
    run: (m, c) => c.copy(copyTextOf(m)),
  }),
  action({
    key: 'p',
    // `!` safe: applies() guarantees toolName ∈ PRIMARY_INPUT.
    label: (s) => `copy ${PRIMARY_INPUT[s.toolName!]!.label}`,
    types: ['grouped_tool_use', 'assistant'],
    applies: (s) => s.toolName != null && s.toolName in PRIMARY_INPUT,
    run: (m, c) => {
      const tc = toolCallOf(m)
      if (!tc) return
      const val = PRIMARY_INPUT[tc.name]?.extract(tc.input)
      if (val) c.copy(val)
    },
  }),
] as const
function isApplicable(a: (typeof MESSAGE_ACTIONS)[number], c: MessageActionsState): boolean {
  if (!(a.types as readonly string[]).includes(c.msgType)) return false
  return !a.applies || a.applies(c)
}
export type MessageActionsState = {
  uuid: string
  msgType: NavigableType
  expanded: boolean
  toolName?: string
}
export type MessageActionsNav = {
  enterCursor: () => void
  navigatePrev: () => void
  navigateNext: () => void
  navigatePrevUser: () => void
  navigateNextUser: () => void
  navigateTop: () => void
  navigateBottom: () => void
  getSelected: () => NavigableMessage | null
}
export const MessageActionsSelectedContext = React.createContext(false)
export const InVirtualListContext = React.createContext(false)

// bg 必须放在有 marginTop 的 Box 上（margin 保持在绘制外部）——这在每个消费者内部。
export function useSelectedMessageBg() {
  return React.useContext(MessageActionsSelectedContext) ? 'messageActionsBackground' : undefined
}

// 不能在这里调用 useKeybindings——hook 在 <KeybindingSetup> provider 外运行。改为返回处理程序。
export function useMessageActions(
  cursor: MessageActionsState | null,
  setCursor: React.Dispatch<React.SetStateAction<MessageActionsState | null>>,
  navRef: RefObject<MessageActionsNav | null>,
  caps: MessageActionCaps,
): {
  enter: () => void
  handlers: Record<string, () => void>
} {
  // Refs 保持处理程序稳定——不会每条消息追加都重新注册 useKeybindings。
  const cursorRef = useRef(cursor)
  cursorRef.current = cursor
  const capsRef = useRef(caps)
  capsRef.current = caps
  const handlers = useMemo(() => {
    const h: Record<string, () => void> = {
      'messageActions:prev': () => navRef.current?.navigatePrev(),
      'messageActions:next': () => navRef.current?.navigateNext(),
      'messageActions:prevUser': () => navRef.current?.navigatePrevUser(),
      'messageActions:nextUser': () => navRef.current?.navigateNextUser(),
      'messageActions:top': () => navRef.current?.navigateTop(),
      'messageActions:bottom': () => navRef.current?.navigateBottom(),
      'messageActions:escape': () =>
        setCursor((c) =>
          c?.expanded
            ? {
                ...c,
                expanded: false,
              }
            : null,
        ),
      // ctrl+c 跳过折叠步骤——从流式期间展开的状态，两阶段
      // 意味着需要 3 次按键来中断（折叠→null→取消）。
      'messageActions:ctrlc': () => setCursor(null),
    }
    for (const action of new Set(MESSAGE_ACTIONS.map((action) => action.key))) {
      h[`messageActions:${action}`] = () => {
        const currentCursor = cursorRef.current
        if (!currentCursor) return
        const matchedAction = MESSAGE_ACTIONS.find(
          (a) => a.key === action && isApplicable(a, currentCursor),
        )
        if (!matchedAction) return
        if (matchedAction.stays) {
          setCursor((prevCursor) =>
            prevCursor
              ? {
                  ...prevCursor,
                  expanded: !prevCursor.expanded,
                }
              : null,
          )
          return
        }
        const selectedMessage = navRef.current?.getSelected()
        if (!selectedMessage) return
        ;(matchedAction.run as (m: NavigableMessage, caps: MessageActionCaps) => void)(
          selectedMessage,
          capsRef.current,
        )
        setCursor(null)
      }
    }
    return h
  }, [setCursor, navRef])
  const enter = useCallback(() => {
    logEvent('zy_message_actions_enter', {})
    navRef.current?.enterCursor()
  }, [navRef])
  return {
    enter,
    handlers,
  }
}

// 必须挂载在 <KeybindingSetup> 内部。
export function MessageActionsKeybindings({ handlers, isActive }) {
  useKeybindings(handlers, {
    context: 'MessageActions',
    isActive,
  })
  return null
}

// 仅 borderTop 的 Box 匹配 PromptInput 的 ─── 线，以保持稳定的页脚高度。
export function MessageActionsBar({ cursor }) {
  const applicable = MESSAGE_ACTIONS.filter((a) => isApplicable(a, cursor))
  const actionItems = applicable.map((action, i) => {
    const label = typeof action.label === 'function' ? action.label(cursor) : action.label
    return (
      <React.Fragment key={action.key}>
        {i > 0 && <Text dimColor={true}> · </Text>}
        <Text bold={true} dimColor={false}>
          {action.key}
        </Text>
        <Text dimColor={true}> {label}</Text>
      </React.Fragment>
    )
  })
  return (
    <Box flexDirection={'column'} flexShrink={0} paddingY={1}>
      {
        <Box
          borderStyle="single"
          borderTop={true}
          borderBottom={false}
          borderLeft={false}
          borderRight={false}
          borderDimColor={true}
        />
      }
      {
        <Box paddingX={2} paddingY={1}>
          {actionItems}
          {<Text dimColor={true}> · </Text>}
          {
            <Text bold={true} dimColor={false}>
              {figures.arrowUp}
              {figures.arrowDown}
            </Text>
          }
          {<Text dimColor={true}> navigate · </Text>}
          {
            <Text bold={true} dimColor={false}>
              esc
            </Text>
          }
          {<Text dimColor={true}> back</Text>}
        </Box>
      }
    </Box>
  )
}
export function stripSystemReminders(text: string): string {
  const CLOSE = '</system-reminder>'
  let textWithoutReminders = text.trimStart()
  while (textWithoutReminders.startsWith('<system-reminder>')) {
    const end = textWithoutReminders.indexOf(CLOSE)
    if (end < 0) break
    textWithoutReminders = textWithoutReminders.slice(end + CLOSE.length).trimStart()
  }
  return textWithoutReminders
}
export function copyTextOf(msg: NavigableMessage): string {
  switch (msg.type) {
    case 'user': {
      const b = msg.message.content[0] as any
      return (b as any)?.type === 'text' ? stripSystemReminders((b as any).text) : ''
    }
    case 'assistant': {
      const b = msg.message.content[0] as any
      if ((b as any)?.type === 'text') return (b as any).text
      const tc = toolCallOf(msg)
      return tc ? (PRIMARY_INPUT[tc.name]?.extract(tc.input) ?? '') : ''
    }
    case 'grouped_tool_use':
      return (msg as any).results.map(toolResultText).filter(Boolean).join('\n\n')
    case 'collapsed_read_search':
      return (msg as any).messages
        .flatMap((m: any) =>
          m.type === 'user'
            ? [toolResultText(m)]
            : m.type === 'grouped_tool_use'
              ? m.results.map(toolResultText)
              : [],
        )
        .filter(Boolean)
        .join('\n\n')
    case 'system':
      if ('content' in msg) return msg.content
      if ('error' in msg) return String(msg.error)
      return msg.subtype
    case 'attachment': {
      const a = msg.attachment
      if (a.type === 'queued_command') {
        const p = (a as any).prompt
        return typeof p === 'string'
          ? p
          : p.flatMap((b: any) => (b.type === 'text' ? [b.text] : [])).join('\n')
      }
      return `[${a.type}]`
    }
  }
}
function toolResultText(r: NormalizedUserMessage): string {
  const b = r.message.content[0]
  if (b?.type !== 'tool_result') return ''
  const c = b.content
  if (typeof c === 'string') return c
  if (!c) return ''
  return c.flatMap((x) => (x.type === 'text' ? [x.text] : [])).join('\n')
}
