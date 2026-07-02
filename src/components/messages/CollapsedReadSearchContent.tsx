import { feature } from 'bun:bundle'
import { basename } from 'node:path'
import React, { useRef } from 'react'
import { useMinDisplayTime } from '../../hooks/useMinDisplayTime.js'
import { tSync } from '../../i18n/index.js'
import { Ansi, Box, Text, useAnimationFrame, useTheme } from '../../ink.js'
import { useReplStore } from '../../state/ReplState.js'
import { findToolByName, type Tools } from '../../Tool.js'
import { getReplPrimitiveTools } from '../../tools/REPLTool/primitiveTools.js'
import type { AssistantMessage, CollapsedReadSearchGroup } from '../../types/message.js'
import { uniq } from '../../utils/array.js'
import { getToolUseIdsFromCollapsedGroup } from '../../utils/collapseReadSearch.js'
import { getDisplayPath } from '../../utils/file.js'
import {
  formatDuration,
  formatSecondsShort,
  getLocalizedDurationFormatter,
} from '../../utils/format.js'
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js'
import type { buildMessageLookups } from '../../utils/messages.js'
import { CtrlOToExpand } from '../CtrlOToExpand.js'
import { useSelectedMessageBg } from '../messageActions.js'
import { PrBadge } from '../PrBadge.js'
import { ToolUseLoader } from '../ToolUseLoader.js'
import { AssistantThinkingMessage } from './AssistantThinkingMessage.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const teamMemCollapsed = feature('TEAMMEM')
  ? (require('./teamMemCollapsed.js') as typeof import('./teamMemCollapsed.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

// 保持每个 ⤿ 提示的最小显示时长，这样快速完成的工具调用
//（bash 命令、文件读取、搜索模式）才是可读的，而不是
// 在一帧内闪烁消失。
const MIN_HINT_DISPLAY_MS = 700
const MAX_THINKING_SUMMARY_CHARS = 300

function truncateThinkingSummary(summary: string, maxChars: number): string {
  return summary.length > maxChars ? `${summary.slice(0, maxChars - 1)}…` : summary
}

type Props = {
  message: CollapsedReadSearchGroup
  inProgressToolUseIDs: Set<string>
  shouldAnimate: boolean
  verbose: boolean
  tools: Tools
  lookups: ReturnType<typeof buildMessageLookups>
  /** True if this is the currently active collapsed group (last one, still loading) */
  isActiveGroup?: boolean
  /** 正在流式输出、尚未落入消息列表的 thinking 文本 */
  streamingThinkingSummary?: string
  // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
  content?: any
  // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
  theme?: any
}

/**
 * 全屏模式下 thinking 实时计时。
 * 对应 CC 的 C13 组件：baseMs + (now - thinkingStartMs) 递增显示。
 */
function ThinkingDurationTick({ baseMs }: { baseMs: number }): React.ReactNode {
  const store = useReplStore()
  const [, time] = useAnimationFrame(1000)
  void time
  const startMs = store.mutable.thinkingStartMs
  const live = startMs > 0 ? Date.now() - startMs : 0
  const fmt = getLocalizedDurationFormatter()
  return <Text bold>{fmt(Math.max(1000, baseMs + live))}</Text>
}

/** 在 verbose 模式下渲染单个工具使用 */
function VerboseToolUse({
  content,
  tools,
  lookups,
  inProgressToolUseIDs,
  shouldAnimate,
  theme,
  message,
  verbose,
}: Props) {
  const bg = useSelectedMessageBg()
  let boxElement
  let earlyReturn: React.ReactNode | symbol
  earlyReturn = Symbol.for('react.early_return_sentinel')
  const tool =
    findToolByName(tools, content.name) ?? findToolByName(getReplPrimitiveTools(), content.name)
  if (!tool) {
    earlyReturn = null
  } else {
    const isResolved = lookups.resolvedToolUseIDs.has(content.id)
    const isError = lookups.erroredToolUseIDs.has(content.id)
    const isInProgress = inProgressToolUseIDs.has(content.id)
    const resultMsg = lookups.toolResultByToolUseID.get(content.id)
    const rawToolResult = resultMsg?.type === 'user' ? resultMsg.toolUseResult : undefined
    const parsedOutput = tool.outputSchema?.safeParse(rawToolResult)
    const toolResult = parsedOutput?.success ? parsedOutput.data : undefined
    const parsedInput = tool.inputSchema.safeParse(content.input)
    const input = parsedInput.success ? parsedInput.data : undefined
    const userFacingName = tool.userFacingName(input)
    const toolUseMessage = input
      ? tool.renderToolUseMessage(input, {
          // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
          theme: theme as any,
          verbose: true,
        })
      : null
    boxElement = (
      // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
      <Box key={content.id} flexDirection="column" marginTop={1} backgroundColor={bg as any}>
        <Box flexDirection="row">
          {
            <ToolUseLoader
              shouldAnimate={shouldAnimate && isInProgress}
              isUnresolved={!isResolved}
              isError={isError}
            />
          }
          <Text>
            <Text bold={true}>{userFacingName}</Text>
            {toolUseMessage && <Text>({toolUseMessage})</Text>}
          </Text>
          {input && tool.renderToolUseTag?.(input)}
        </Box>
        {isResolved && !isError && toolResult !== undefined && (
          <Box>
            {tool.renderToolResultMessage?.(toolResult, [], {
              verbose: true,
              tools,
              // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
              theme: theme as any,
            })}
          </Box>
        )}
      </Box>
    )
  }
  if (earlyReturn !== Symbol.for('react.early_return_sentinel')) {
    return earlyReturn as React.ReactNode
  }
  return boxElement
}
export function CollapsedReadSearchContent({
  message,
  inProgressToolUseIDs,
  shouldAnimate,
  verbose,
  tools,
  lookups,
  isActiveGroup,
  streamingThinkingSummary,
}: Props): React.ReactNode {
  const bg = useSelectedMessageBg()
  const store = useReplStore()
  const {
    searchCount: rawSearchCount,
    readCount: rawReadCount,
    listCount: rawListCount,
    replCount,
    memorySearchCount,
    memoryReadCount,
    memoryWriteCount,
    messages: groupMessages,
  } = message
  const [theme] = useTheme()
  const toolUseIds = getToolUseIdsFromCollapsedGroup(message)
  const anyError = toolUseIds.some((id) => lookups.erroredToolUseIDs.has(id))
  const hasMemoryOps =
    (memorySearchCount ?? 0) > 0 || (memoryReadCount ?? 0) > 0 || (memoryWriteCount ?? 0) > 0
  const hasTeamMemoryOps = feature('TEAMMEM')
    ? teamMemCollapsed!.checkHasTeamMemOps(message)
    : false

  // 跟踪最大已见计数，使其只能递增。debounce 计时器
  // 会在任意时刻产生额外的 re-render；在流式执行器的
  // 短暂"不可见窗口"期间，组计数可能下降，这会导致抖动。
  const maxReadCountRef = useRef(0)
  const maxSearchCountRef = useRef(0)
  const maxListCountRef = useRef(0)
  const maxMcpCountRef = useRef(0)
  const maxBashCountRef = useRef(0)
  maxReadCountRef.current = Math.max(maxReadCountRef.current, rawReadCount ?? 0)
  maxSearchCountRef.current = Math.max(maxSearchCountRef.current, rawSearchCount ?? 0)
  maxListCountRef.current = Math.max(maxListCountRef.current, rawListCount ?? 0)
  maxMcpCountRef.current = Math.max(maxMcpCountRef.current, message.mcpCallCount ?? 0)
  maxBashCountRef.current = Math.max(maxBashCountRef.current, message.bashCount ?? 0)
  const readCount = maxReadCountRef.current
  const searchCount = maxSearchCountRef.current
  const listCount = maxListCountRef.current
  const mcpCallCount = maxMcpCountRef.current
  // 减去作为 "Committed …" / "Created PR …" 显示的命令，这样
  // 同一命令不会被计数两次。gitOpBashCount 是实时读取的（不需要 max-ref，
  // 在结果到达之前为 0，之后只增不减）。
  const gitOpBashCount = message.gitOpBashCount ?? 0
  const bashCount = isFullscreenEnvEnabled()
    ? Math.max(0, maxBashCountRef.current - gitOpBashCount)
    : 0
  const hasNonMemoryOps =
    searchCount > 0 ||
    readCount > 0 ||
    listCount > 0 ||
    (replCount ?? 0) > 0 ||
    mcpCallCount > 0 ||
    bashCount > 0 ||
    gitOpBashCount > 0
  // 纯 thinking 折叠块（无任何工具调用计数）也可能存在
  const hasThinkingContent =
    (message.thinkingDurationMs ?? 0) > 0 || message.latestThinkingSummary !== undefined
  const readPaths = message.readFilePaths
  const searchArgs = message.searchArgs as string[] | undefined
  let incomingHint = message.latestDisplayHint
  if (incomingHint === undefined) {
    const lastSearchRaw = searchArgs?.at(-1)
    const lastSearch = lastSearchRaw !== undefined ? `"${lastSearchRaw}"` : undefined
    const lastRead = readPaths?.at(-1)
    incomingHint = lastRead !== undefined ? getDisplayPath(lastRead) : lastSearch
  }

  // 活跃的 REPL 调用发出 repl_tool_call 进度，包含当前内部
  // 工具的 name+input。虚拟消息直到 REPL 完成才到达，
  // 因此这是执行期间实时提示的唯一来源。
  if (isActiveGroup) {
    for (const id_0 of toolUseIds) {
      if (!inProgressToolUseIDs.has(id_0)) {
        continue
      }
      const latest = lookups.progressMessagesByToolUseID.get(id_0)?.at(-1)?.data
      // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
      if ((latest as any)?.type === 'repl_tool_call' && (latest as any).phase === 'start') {
        // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
        const input = (latest as any).toolInput as {
          command?: string
          pattern?: string
          file_path?: string
        }
        incomingHint =
          input.file_path ??
          (input.pattern ? `"${input.pattern}"` : undefined) ??
          input.command ??
          // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
          (latest as any).toolName
      }
    }
  }
  const fallbackHint = useMinDisplayTime(incomingHint, MIN_HINT_DISPLAY_MS)
  const streamMode = store.getState().streamMode
  const isToolStreamMode = streamMode === 'tool-use' || streamMode === 'tool-input'
  const liveThinkingSummary =
    isActiveGroup && streamMode === 'thinking' ? streamingThinkingSummary?.trim() : undefined
  const rawThinkingSummary =
    liveThinkingSummary !== undefined && liveThinkingSummary !== ''
      ? liveThinkingSummary
      : message.latestThinkingSummary
  const thinkingSummary = rawThinkingSummary
    ? truncateThinkingSummary(rawThinkingSummary.replace(/\s+/g, ' '), MAX_THINKING_SUMMARY_CHARS)
    : undefined
  // 活跃分组按真实流状态切换提示；非活跃或状态短暂缺失时，
  // 回退到归组阶段记录的最近可展示活动，避免首个子块类型粘住。
  const displayedHint =
    isActiveGroup && streamMode === 'thinking'
      ? (thinkingSummary ?? fallbackHint)
      : isActiveGroup && isToolStreamMode && fallbackHint !== undefined
        ? fallbackHint
        : message.latestDisplayKind === 'thinking'
          ? (thinkingSummary ?? fallbackHint)
          : (fallbackHint ?? thinkingSummary)

  // 在 verbose 模式下，渲染每个工具使用及其 1 行结果摘要
  if (verbose) {
    const items: AssistantMessage[] = []
    for (const msg of groupMessages ?? []) {
      if (msg.type === 'assistant') {
        items.push(msg)
      } else if (msg.type === 'grouped_tool_use') {
        items.push(...(msg.message as unknown as AssistantMessage[]))
      }
    }
    return (
      <Box flexDirection="column">
        {items.map((msg_0) => {
          const content = msg_0.message.content[0]
          // 在工具调用之间内联渲染 thinking 块
          if (content?.type === 'thinking' && content.thinking) {
            return (
              <AssistantThinkingMessage
                key={msg_0.uuid}
                param={content}
                addMargin={true}
                isTranscriptMode={true}
                verbose={true}
              />
            )
          }
          if (content?.type !== 'tool_call') {
            return null
          }
          return (
            <VerboseToolUse
              key={content.id}
              content={content}
              tools={tools}
              lookups={lookups}
              inProgressToolUseIDs={inProgressToolUseIDs}
              shouldAnimate={shouldAnimate}
              // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
              theme={theme as any}
              // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
              message={msg_0.message as any}
              verbose={verbose}
            />
          )
        })}
        {message.hookInfos && message.hookInfos.length > 0 && (
          <>
            <Text dimColor>
              {'  ⎿  '}Ran {message.hookCount} PreToolUse{' '}
              {message.hookCount === 1 ? 'hook' : 'hooks'} (
              {formatSecondsShort(message.hookTotalMs ?? 0)})
            </Text>
            {/* biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容 */}
            {message.hookInfos.map((info: any, idx: number) => (
              <Text key={`hook-${idx}`} dimColor>
                {'     ⎿ '}
                {info.command} ({formatSecondsShort(info.durationMs ?? 0)})
              </Text>
            ))}
          </>
        )}
        {/* biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容 */}
        {message.relevantMemories?.map((m: any) => (
          <Box key={m.path} flexDirection="column" marginTop={1}>
            <Text dimColor>
              {'  ⎿  '}Recalled {basename(m.path)}
            </Text>
            <Box paddingLeft={5}>
              <Text>
                <Ansi>{m.content}</Ansi>
              </Text>
            </Box>
          </Box>
        ))}
      </Box>
    )
  }

  // 非 verbose 模式：活跃时显示带闪烁灰点的计数，完成后显示绿点
  // 活跃时使用现在时，完成后使用过去时

  // 防御性检查：如果所有计数都为 0 且无 thinking 内容，不渲染折叠组
  if (!hasMemoryOps && !hasTeamMemoryOps && !hasNonMemoryOps && !hasThinkingContent) {
    return null
  }

  // 找到此组中最慢的正在执行的 shell 命令。BashTool 每秒
  // 产生进度，但折叠渲染器从未显示过它——长耗时命令
  //（npm install、测试）看起来像是卡住了。2 秒后显示，这样快速
  // 命令保持干净；跳动的计数器让用户确信慢命令没有卡住。
  let shellProgressSuffix = ''
  if (isFullscreenEnvEnabled() && isActiveGroup) {
    let elapsed: number | undefined
    let lines = 0
    for (const id_1 of toolUseIds) {
      if (!inProgressToolUseIDs.has(id_1)) {
        continue
      }
      const data = lookups.progressMessagesByToolUseID.get(id_1)?.at(-1)?.data
      if (data?.type !== 'bash_progress' && data?.type !== 'powershell_progress') {
        continue
      }
      if (elapsed === undefined || data.elapsedTimeSeconds > elapsed) {
        elapsed = data.elapsedTimeSeconds
        lines = data.totalLines
      }
    }
    if (elapsed !== undefined && elapsed >= 2) {
      const time = formatDuration(elapsed * 1000)
      const lineUnit = tSync(lines === 1 ? 'summary.line_one' : 'summary.line_other', {
        count: lines,
      })
      shellProgressSuffix = lines > 0 ? ` (${time} · ${lines} ${lineUnit})` : ` (${time})`
    }
  }

  // 首先构建非 memory 部分（thinking、search、read、repl、mcp、bash）——这些在 memory 之前渲染，
  // 这样行读起来是 "Thought 12.3s, ran 3 bash commands, recalled 1 memory"。
  const nonMemParts: React.ReactNode[] = []

  // 思考时长引领行首（无 git 操作时）
  // 正在思考（streamMode === 'thinking'）&& fullscreen → 实时 tick "正在思考 Xs"
  // 完成后 → 静态 "思考了 Xs"（下限 1s）
  const thinkingMs = message.thinkingDurationMs ?? 0
  const isCurrentlyThinking = streamMode === 'thinking'
  const showThinkingTick = isActiveGroup && isFullscreenEnvEnabled() && isCurrentlyThinking
  if (thinkingMs > 0 || showThinkingTick) {
    const isFirst = nonMemParts.length === 0
    const position = isFirst ? 'first' : 'sub'
    if (showThinkingTick) {
      const label = tSync(`summary.thinking.active.${position}`, { duration: '' }).trimEnd()
      nonMemParts.push(
        <Text key="thinking">
          {label} <ThinkingDurationTick baseMs={thinkingMs} />
        </Text>,
      )
    } else {
      const fmt = getLocalizedDurationFormatter()
      nonMemParts.push(
        <Text key="thinking">
          {tSync(`summary.thinking.done.${position}`, {
            duration: fmt(Math.max(1000, thinkingMs)),
          })}
        </Text>,
      )
    }
  }

  // Git 操作引领行首——它们是关键的产出结果。
  function pushPart(key: string, verbKey: string, body: React.ReactNode): void {
    const isFirst = nonMemParts.length === 0
    if (!isFirst) {
      nonMemParts.push(<Text key={`comma-${key}`}>, </Text>)
    }
    const verb = tSync(`summary.git.${verbKey}`)
    nonMemParts.push(
      <Text key={key}>
        {isFirst ? verb[0]!.toUpperCase() + verb.slice(1) : verb} {body}
      </Text>,
    )
  }
  if (isFullscreenEnvEnabled() && message.commits?.length) {
    for (const kind of ['committed', 'amended', 'cherryPicked'] as const) {
      const shas = message.commits
        // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
        .filter((c: any) => c.kind === kind.replace('Picked', '-picked'))
        // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
        .map((c_0: any) => c_0.sha)
      if (shas.length) {
        pushPart(kind, kind, <Text bold>{shas.join(', ')}</Text>)
      }
    }
  }
  if (isFullscreenEnvEnabled() && message.pushes?.length) {
    // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
    const branches = uniq(message.pushes.map((p: any) => p.branch))
    pushPart('push', 'pushedTo', <Text bold>{branches.join(', ')}</Text>)
  }
  if (isFullscreenEnvEnabled() && message.branches?.length) {
    for (const b of message.branches as Array<{ action: string; ref: string }>) {
      pushPart(
        `br-${b.action}-${b.ref}`,
        b.action === 'merged' ? 'merged' : 'rebasedOnto',
        <Text bold>{b.ref}</Text>,
      )
    }
  }
  if (isFullscreenEnvEnabled() && message.prs?.length) {
    for (const pr of message.prs as Array<{ action: string; number: number; url?: string }>) {
      const verbKey =
        pr.action === 'ready'
          ? 'prMarkedReady'
          : `pr${pr.action[0]!.toUpperCase()}${pr.action.slice(1)}`
      pushPart(
        `pr-${pr.action}-${pr.number}`,
        verbKey,
        pr.url ? (
          <PrBadge number={pr.number} url={pr.url} bold />
        ) : (
          <Text bold>PR #{pr.number}</Text>
        ),
      )
    }
  }
  if (searchCount > 0) {
    const isFirst_0 = nonMemParts.length === 0
    const phase = isActiveGroup ? 'active' : 'done'
    const position = isFirst_0 ? 'first' : 'sub'
    const searchKey = `summary.search.${phase}.${position}`
    const searchUnit = tSync(
      searchCount === 1 ? 'summary.search.pattern_one' : 'summary.search.pattern_other',
      {
        count: searchCount,
      },
    )
    if (!isFirst_0) {
      nonMemParts.push(<Text key="comma-s">, </Text>)
    }
    nonMemParts.push(
      <Text key="search">
        {tSync(searchKey, {
          count: searchCount,
          unit: searchUnit,
        })}
      </Text>,
    )
  }
  if (readCount > 0) {
    const isFirst_1 = nonMemParts.length === 0
    const phase = isActiveGroup ? 'active' : 'done'
    const position = isFirst_1 ? 'first' : 'sub'
    const readKey = `summary.read.${phase}.${position}`
    const readUnit = tSync(readCount === 1 ? 'summary.read.file_one' : 'summary.read.file_other', {
      count: readCount,
    })
    if (!isFirst_1) {
      nonMemParts.push(<Text key="comma-r">, </Text>)
    }
    nonMemParts.push(
      <Text key="read">
        {tSync(readKey, {
          count: readCount,
          unit: readUnit,
        })}
      </Text>,
    )
  }
  if (listCount > 0) {
    const isFirst_2 = nonMemParts.length === 0
    const phase = isActiveGroup ? 'active' : 'done'
    const position = isFirst_2 ? 'first' : 'sub'
    const listKey = `summary.list.${phase}.${position}`
    const listUnit = tSync(
      listCount === 1 ? 'summary.list.directory_one' : 'summary.list.directory_other',
      {
        count: listCount,
      },
    )
    if (!isFirst_2) {
      nonMemParts.push(<Text key="comma-l">, </Text>)
    }
    nonMemParts.push(
      <Text key="list">
        {tSync(listKey, {
          count: listCount,
          unit: listUnit,
        })}
      </Text>,
    )
  }
  if ((replCount ?? 0) > 0) {
    const replKey = isActiveGroup ? 'summary.repl.active' : 'summary.repl.done'
    const replUnit = tSync(replCount === 1 ? 'summary.repl.time_one' : 'summary.repl.time_other', {
      count: replCount ?? 0,
    })
    if (nonMemParts.length > 0) {
      nonMemParts.push(<Text key="comma-repl">, </Text>)
    }
    nonMemParts.push(
      <Text key="repl">
        {tSync(replKey, {
          count: replCount ?? 0,
          unit: replUnit,
        })}
      </Text>,
    )
  }
  if (mcpCallCount > 0) {
    const serverLabel =
      // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
      message.mcpServerNames?.map((n: any) => n.replace(/^zy\.ai /, '')).join(', ') || 'MCP'
    const isFirst_3 = nonMemParts.length === 0
    const phase = isActiveGroup ? 'active' : 'done'
    const position = isFirst_3 ? 'first' : 'sub'
    const mcpKey = `summary.mcp.${phase}.${position}`
    if (!isFirst_3) {
      nonMemParts.push(<Text key="comma-mcp">, </Text>)
    }
    nonMemParts.push(
      <Text key="mcp">
        {tSync(mcpKey, {
          server: serverLabel,
        })}
        {mcpCallCount > 1 && (
          <>
            {' '}
            <Text bold>{mcpCallCount}</Text>{' '}
            {tSync('summary.repl.time_other', {
              count: mcpCallCount,
            })}
          </>
        )}
      </Text>,
    )
  }
  if (isFullscreenEnvEnabled() && bashCount > 0) {
    const isFirst_4 = nonMemParts.length === 0
    const phase = isActiveGroup ? 'active' : 'done'
    const position = isFirst_4 ? 'first' : 'sub'
    const bashKey = `summary.bash.${phase}.${position}`
    const bashUnit = tSync(
      bashCount === 1 ? 'summary.bash.command_one' : 'summary.bash.command_other',
      {
        count: bashCount,
      },
    )
    if (!isFirst_4) {
      nonMemParts.push(<Text key="comma-bash">, </Text>)
    }
    nonMemParts.push(
      <Text key="bash">
        {tSync(bashKey, {
          count: bashCount,
          unit: bashUnit,
        })}
      </Text>,
    )
  }

  // 构建 memory 部分（auto-memory）——在 nonMemParts 之后渲染
  const hasPrecedingNonMem = nonMemParts.length > 0
  const memParts: React.ReactNode[] = []
  if ((memoryReadCount ?? 0) > 0) {
    const isFirst_5 = !hasPrecedingNonMem && memParts.length === 0
    const phase = isActiveGroup ? 'active' : 'done'
    const position = isFirst_5 ? 'first' : 'sub'
    const mrKey = `summary.memoryRead.${phase}.${position}`
    const mrUnit = tSync(memoryReadCount === 1 ? 'summary.memory_one' : 'summary.memory_other', {
      count: memoryReadCount ?? 0,
    })
    if (!isFirst_5) {
      memParts.push(<Text key="comma-mr">, </Text>)
    }
    memParts.push(
      <Text key="mem-read">
        {tSync(mrKey, {
          count: memoryReadCount ?? 0,
          unit: mrUnit,
        })}
      </Text>,
    )
  }
  if ((memorySearchCount ?? 0) > 0) {
    const isFirst_6 = !hasPrecedingNonMem && memParts.length === 0
    const phase = isActiveGroup ? 'active' : 'done'
    const position = isFirst_6 ? 'first' : 'sub'
    const msKey = `summary.memorySearch.${phase}.${position}`
    if (!isFirst_6) {
      memParts.push(<Text key="comma-ms">, </Text>)
    }
    memParts.push(<Text key="mem-search">{tSync(msKey)}</Text>)
  }
  if ((memoryWriteCount ?? 0) > 0) {
    const isFirst_7 = !hasPrecedingNonMem && memParts.length === 0
    const phase = isActiveGroup ? 'active' : 'done'
    const position = isFirst_7 ? 'first' : 'sub'
    const mwKey = `summary.memoryWrite.${phase}.${position}`
    const mwUnit = tSync(memoryWriteCount === 1 ? 'summary.memory_one' : 'summary.memory_other', {
      count: memoryWriteCount ?? 0,
    })
    if (!isFirst_7) {
      memParts.push(<Text key="comma-mw">, </Text>)
    }
    memParts.push(
      <Text key="mem-write">
        {tSync(mwKey, {
          count: memoryWriteCount ?? 0,
          unit: mwUnit,
        })}
      </Text>,
    )
  }
  return (
    // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
    <Box flexDirection="column" marginTop={1} backgroundColor={bg as any}>
      <Box flexDirection="row">
        {isActiveGroup ? (
          <ToolUseLoader shouldAnimate isUnresolved isError={anyError} />
        ) : (
          <Box minWidth={2} />
        )}
        <Text dimColor={!isActiveGroup}>
          {nonMemParts}
          {memParts}
          {feature('TEAMMEM')
            ? teamMemCollapsed!.TeamMemCountParts({
                // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
                message: message as any,
                isActiveGroup,
                hasPrecedingParts: hasPrecedingNonMem || memParts.length > 0,
              })
            : null}
          {isActiveGroup && <Text key="ellipsis">…</Text>} <CtrlOToExpand />
        </Text>
      </Box>
      {isActiveGroup && displayedHint !== undefined && (
        // 行布局：5 宽 gutter 用于 ⎿，然后是 flex 列用于文本。
        // Ink 的 wrap 保留在右侧列内，因此续行在 ⎿ 下方缩进。
        // MAX_HINT_CHARS in commandAsHint 将总计限制为约 5 行。
        <Box flexDirection="row">
          <Box width={5} flexShrink={0}>
            <Text dimColor>{'  ⎿  '}</Text>
          </Box>
          <Box flexDirection="column" flexGrow={1}>
            {displayedHint.split('\n').map((line, i, arr) => (
              <Text key={`hint-${i}`} dimColor>
                {line}
                {i === arr.length - 1 && shellProgressSuffix}
              </Text>
            ))}
          </Box>
        </Box>
      )}
      {message.hookTotalMs !== undefined && message.hookTotalMs > 0 && (
        <Text dimColor>
          {'  ⎿  '}Ran {message.hookCount} PreToolUse {message.hookCount === 1 ? 'hook' : 'hooks'} (
          {formatSecondsShort(message.hookTotalMs)})
        </Text>
      )}
    </Box>
  )
}
