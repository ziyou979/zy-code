import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNotifications } from 'src/context/notifications.js'
import { Text } from 'src/ink/index.js'
import { logEvent } from 'src/services/analytics/index.js'
import { useDebounceCallback } from 'usehooks-ts'
import { type Command, getCommandName } from '../commands/index.js'
import { getModeFromInput, getValueFromInput } from '../components/PromptInput/inputModes.js'
import {
  getNextSuggestionIndex,
  handleAutocompleteArrowFallback,
} from '../components/PromptInput/promptInputNavigation.js'
import type {
  SuggestionItem,
  SuggestionType,
} from '../components/PromptInput/PromptInputFooterSuggestions.js'
import { useIsModalOverlayActive, useRegisterOverlay } from '../context/OverlayContext.js'
import { KeyboardEvent } from '../ink/events/keyboardEvent.js'
// eslint-disable-next-line custom-rules/prefer-use-keybindings -- backward-compat bridge until consumers wire handleKeyDown to <Box onKeyDown>
import { useInput } from '../ink/index.js'
import {
  useOptionalKeybindingContext,
  useRegisterKeybindingContext,
} from '../keybindings/KeybindingContext.js'
import { useKeybindings } from '../keybindings/useKeybinding.js'
import { useShortcutDisplay } from '../keybindings/useShortcutDisplay.js'
import {
  applyCommandSuggestion,
  findMidInputSlashCommand,
  generateCommandSuggestions,
  getBestCommandMatch,
  isCommandInput,
} from '../services/suggestions/commandSuggestions.js'
import {
  getDirectoryCompletions,
  getPathCompletions,
  isPathLikeToken,
} from '../services/suggestions/directoryCompletion.js'
import {
  getShellHistoryCompletion,
  getShellHistoryCompletionSync,
} from '../services/suggestions/shellHistoryCompletion.js'
import {
  getSlackChannelSuggestions,
  hasSlackMcpServer,
} from '../services/suggestions/slackChannelSuggestions.js'
import { TEAM_LEAD_NAME } from '../services/swarm/constants.js'
import type { ShellCompletionType } from '../shell-eval/bash/shellCompletion.js'
import { useAppState, useAppStateStore } from '../state/AppState.js'
import type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'
import type { InlineGhostText, PromptInputMode } from '../types/textInputTypes.js'
import { isAgentSwarmsEnabled } from '../services/swarm/agentSwarmsEnabled.js'
import { generateProgressiveArgumentHint, parseArguments } from '../utils/argumentParser.js'
import { isTestEnv } from '../services/infra/envUtils.js'
import { formatLogMetadata } from '../utils/format.js'
import { getSessionIdFromLog, searchSessionsByCustomTitle } from '../services/sessionStorage.js'
import {
  applyFileSuggestion,
  findLongestCommonPrefix,
  onIndexBuildComplete,
  startBackgroundCacheRefresh,
} from './fileSuggestions.js'
import { generateUnifiedSuggestions } from './unifiedSuggestions.js'
import {
  applyDirectorySuggestion,
  applyShellSuggestion,
  applyTriggerSuggestion,
  AT_TOKEN_HEAD_RE,
  buildResumeInputFromSuggestion,
  DM_MEMBER_RE,
  extractCommandNameAndArgs,
  extractCompletionToken,
  extractSearchToken,
  findShellTokenStart,
  formatReplacementValue,
  generateBashSuggestions,
  getCommandSelectionForInputUpdate,
  getPreservedSelection,
  hasCommandWithArguments,
  HAS_AT_SYMBOL_RE,
  HASH_CHANNEL_RE,
  isPathMetadata,
  PATH_CHAR_HEAD_RE,
} from './typeaheadTokenUtils.js'
type Props = {
  onInputChange: (value: string) => void
  onSubmit: (value: string, isSubmittingSlashCommand?: boolean) => void
  setCursorOffset: (offset: number) => void
  input: string
  cursorOffset: number
  commands: Command[]
  mode: string
  agents: AgentDefinition[]
  setSuggestionsState: (
    f: (previousSuggestionsState: {
      suggestions: SuggestionItem[]
      selectedSuggestion: number
      commandArgumentHint?: string
    }) => {
      suggestions: SuggestionItem[]
      selectedSuggestion: number
      commandArgumentHint?: string
    },
  ) => void
  suggestionsState: {
    suggestions: SuggestionItem[]
    selectedSuggestion: number
    commandArgumentHint?: string
  }
  suppressSuggestions?: boolean
  markAccepted: () => void
  onModeChange?: (mode: PromptInputMode) => void
}
type UseTypeaheadResult = {
  suggestions: SuggestionItem[]
  selectedSuggestion: number
  hoveredSuggestionId: string | null
  suggestionType: SuggestionType
  maxColumnWidth?: number
  commandArgumentHint?: string
  inlineGhostText?: InlineGhostText
  handleKeyDown: (e: KeyboardEvent) => void
  acceptSuggestion: (index: number) => void
  onClickSuggestion: (index: number) => void
  onHoverSuggestion: (id: string | null) => void
}
/**
 * 处理命令和文件路径 typeahead 功能的 hook
 */
export function useTypeahead({
  commands,
  onInputChange,
  onSubmit,
  setCursorOffset,
  input,
  cursorOffset,
  mode,
  agents,
  setSuggestionsState,
  suggestionsState: { suggestions, selectedSuggestion, commandArgumentHint },
  suppressSuggestions = false,
  markAccepted,
  onModeChange,
}: Props): UseTypeaheadResult {
  // 与 CC 一致，hover 独立于候选生成状态；候选异步刷新不能覆盖鼠标模态。
  const [hoveredSuggestionId, setHoveredSuggestionId] = useState<string | null>(null)
  const { addNotification } = useNotifications()
  const thinkingToggleShortcut = useShortcutDisplay('chat:thinkingToggle', 'Chat', 'alt+t')
  const [suggestionType, setSuggestionType] = useState<SuggestionType>('none')

  // 根据所有命令而非过滤结果一次性计算最大列宽，避免过滤时布局偏移
  const allCommandsMaxWidth = useMemo(() => {
    const visibleCommands = commands.filter((cmd) => !cmd.isHidden)
    if (visibleCommands.length === 0) {
      return undefined
    }
    const maxLen = Math.max(...visibleCommands.map((cmd) => getCommandName(cmd).length))
    return maxLen + 6 // +1 for "/" prefix, +5 for padding
  }, [commands])
  const [maxColumnWidth, setMaxColumnWidth] = useState<number | undefined>(undefined)
  const mcpResources = useAppState((s) => s.mcp.resources)
  const store = useAppStateStore()
  const promptSuggestion = useAppState((s) => s.promptSuggestion)
  // PromptInput 在 teammate 视图隐藏 suggestion ghost text；此处使用相同门控，
  // 避免 Tab/rightArrow 接受未显示的内容。
  const isViewingTeammate = useAppState((s) => !!s.viewingAgentTaskId)

  // 访问 keybinding context，检查待处理的 chord sequence
  const keybindingContext = useOptionalKeybindingContext()

  // 行内 ghost text 状态（bash 历史补全，异步）
  const [inlineGhostText, setInlineGhostText] = useState<InlineGhostText | undefined>(undefined)

  // prompt 模式行中 slash command 的同步 ghost text。render 期间通过 useMemo 计算，
  // 消除 useState + useEffect 因 effect 晚于 render 而产生的单帧闪烁。
  const syncPromptGhostText = useMemo((): InlineGhostText | undefined => {
    if (mode !== 'prompt' || suppressSuggestions) {
      return undefined
    }
    const midInputCommand = findMidInputSlashCommand(input, cursorOffset)
    if (!midInputCommand) {
      return undefined
    }
    const match = getBestCommandMatch(midInputCommand.partialCommand, commands)
    if (!match) {
      return undefined
    }
    return {
      text: match.suffix,
      fullCommand: match.fullCommand,
      insertPosition: midInputCommand.startPos + 1 + midInputCommand.partialCommand.length,
    }
  }, [input, cursorOffset, mode, commands, suppressSuggestions])

  // 合并的 ghost text：prompt 模式使用同步 useMemo，bash 模式使用异步 useState
  const effectiveGhostText = suppressSuggestions
    ? undefined
    : mode === 'prompt'
      ? syncPromptGhostText
      : inlineGhostText

  // 用 ref 保存 cursorOffset，避免仅移动光标就重新触发 suggestion；
  // 只在实际 search token 变化时重新获取
  const cursorOffsetRef = useRef(cursorOffset)
  cursorOffsetRef.current = cursorOffset

  // 跟踪最新 search token，丢弃慢速异步操作返回的旧结果
  const latestSearchTokenRef = useRef<string | null>(null)
  // 跟踪上一次输入，区分真实文本变化和 callback 重建
  const prevInputRef = useRef('')
  // 跟踪最新 path token，丢弃路径补全的旧结果
  const latestPathTokenRef = useRef('')
  // 跟踪最新 bash 输入，丢弃历史补全的旧结果
  const latestBashInputRef = useRef('')
  // 跟踪最新 Slack channel token，丢弃 MCP 返回的旧结果
  const latestSlackTokenRef = useRef('')
  // 用 ref 跟踪 suggestion，避免选区变化时重建 updateSuggestions
  const suggestionsRef = useRef(suggestions)
  suggestionsRef.current = suggestions
  // 记录手动关闭 suggestion 时的输入值，防止再次触发
  const dismissedForInputRef = useRef<string | null>(null)

  // 清除所有 suggestion
  const clearSuggestions = useCallback(() => {
    setSuggestionsState(() => ({
      commandArgumentHint: undefined,
      suggestions: [],
      selectedSuggestion: -1,
    }))
    setHoveredSuggestionId(null)
    setSuggestionType('none')
    setMaxColumnWidth(undefined)
    setInlineGhostText(undefined)
  }, [setSuggestionsState])

  // 获取文件/resource suggestion 的高开销异步操作
  const fetchFileSuggestions = useCallback(
    async (searchToken: string, isAtSymbol = false): Promise<void> => {
      latestSearchTokenRef.current = searchToken
      const combinedItems = await generateUnifiedSuggestions(
        searchToken,
        mcpResources,
        agents,
        isAtSymbol,
      )
      // 等待期间已有更新 query 发起时丢弃旧结果
      if (latestSearchTokenRef.current !== searchToken) {
        return
      }
      if (combinedItems.length === 0) {
        // 内联 clearSuggestions 逻辑，避免依赖 debouncedFetchFileSuggestions
        setSuggestionsState(() => ({
          commandArgumentHint: undefined,
          suggestions: [],
          selectedSuggestion: -1,
        }))
        setSuggestionType('none')
        setMaxColumnWidth(undefined)
        return
      }
      setSuggestionsState((prev) => ({
        commandArgumentHint: undefined,
        suggestions: combinedItems,
        selectedSuggestion: getPreservedSelection(
          prev.suggestions,
          prev.selectedSuggestion,
          combinedItems,
        ),
      }))
      setSuggestionType(combinedItems.length > 0 ? 'file' : 'none')
      setMaxColumnWidth(undefined) // No fixed width for file suggestions
    },
    [mcpResources, setSuggestionsState, agents],
  )

  // 挂载时预热文件索引，避免首次 @-mention 阻塞。构建在后台运行，每约 4ms
  // 让出 event loop，不会延迟首帧，只会与用户首次按下 @ 竞争。
  //
  // 构建完成前输入时先返回已就绪 chunk 的部分结果；完成后重新执行最近一次搜索，
  // 将部分结果升级为完整结果。清除 token ref，避免同一 query 被当作旧结果丢弃。
  //
  // NODE_ENV=test 时跳过：挂载 REPL 的测试会在真实 CI workspace 上运行 git ls-files，
  // Windows runner 可能有 27 万多个文件；后台构建会活过测试，并让 setImmediate 链泄漏到
  // 同 shard 的后续测试。subscriber 仍会注册，使直接触发 refresh 的 fileSuggestions 测试正常。
  useEffect(() => {
    if (!isTestEnv()) {
      startBackgroundCacheRefresh()
    }
    return onIndexBuildComplete(() => {
      const token = latestSearchTokenRef.current
      if (token !== null) {
        latestSearchTokenRef.current = null
        void fetchFileSuggestions(token, token === '')
      }
    })
  }, [fetchFileSuggestions])

  // 对文件获取做 debounce。50ms 略高于 macOS 默认约 33ms 的按键重复间隔，
  // 按住 delete/backspace 时可合并为一次搜索，避免每次重复按键都卡顿。
  // 27 万文件索引上的搜索本身约耗时 8-15ms。
  const debouncedFetchFileSuggestions = useDebounceCallback(fetchFileSuggestions, 50)

  // Bash 模式历史 ghost text：冷缓存时会扫 history JSONL；每键 await 会让输入掉帧。
  // 与文件建议同档 50ms 合并连打；有缓存后 lookup 本身很轻。
  const debouncedBashHistoryGhost = useDebounceCallback(async (value: string) => {
    latestBashInputRef.current = value
    const historyMatch = await getShellHistoryCompletion(value)
    if (latestBashInputRef.current !== value) {
      return
    }
    if (historyMatch) {
      setInlineGhostText({
        text: historyMatch.suffix,
        fullCommand: historyMatch.fullCommand,
        insertPosition: value.length,
      })
      setSuggestionsState(() => ({
        commandArgumentHint: undefined,
        suggestions: [],
        selectedSuggestion: -1,
      }))
      setSuggestionType('none')
      setMaxColumnWidth(undefined)
    } else {
      setInlineGhostText(undefined)
    }
  }, 50)
  const fetchSlackChannels = useCallback(
    async (partial: string): Promise<void> => {
      latestSlackTokenRef.current = partial
      const channels = await getSlackChannelSuggestions(store.getState().mcp.clients, partial)
      if (latestSlackTokenRef.current !== partial) {
        return
      }
      setSuggestionsState((prev) => ({
        commandArgumentHint: undefined,
        suggestions: channels,
        selectedSuggestion: getPreservedSelection(
          prev.suggestions,
          prev.selectedSuggestion,
          channels,
        ),
      }))
      setSuggestionType(channels.length > 0 ? 'slack-channel' : 'none')
      setMaxColumnWidth(undefined)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- store is a stable context ref
    [setSuggestionsState, store.getState],
  )

  // # 后首次按键需要 MCP 往返；首个 word segment 相同的后续按键会同步命中 cache。
  const debouncedFetchSlackChannels = useDebounceCallback(fetchSlackChannels, 150)

  // 处理即时 suggestion 逻辑（低开销操作）
  // biome-ignore lint/correctness/useExhaustiveDependencies: store is a stable context ref, read imperatively at call-time
  const updateSuggestions = useCallback(
    async (
      value: string,
      inputCursorOffset?: number,
      previousInput: string = value,
    ): Promise<void> => {
      // 使用传入的 cursor offset，否则回退到 ref，避免依赖 cursorOffset
      const effectiveCursorOffset = inputCursorOffset ?? cursorOffsetRef.current
      if (suppressSuggestions) {
        debouncedFetchFileSuggestions.cancel()
        debouncedBashHistoryGhost.cancel()
        clearSuggestions()
        return
      }

      // 检查行中 slash command（如 "help me /com"）。仅用于 prompt 模式；
      // 输入以 "/" 开头时由其他逻辑处理。prompt ghost text 已通过 syncPromptGhostText
      // useMemo 同步计算，此处只需在其活跃时清除下拉 suggestion。
      if (mode === 'prompt') {
        const midInputCommand = findMidInputSlashCommand(value, effectiveCursorOffset)
        if (midInputCommand) {
          const match = getBestCommandMatch(midInputCommand.partialCommand, commands)
          if (match) {
            // 显示 ghost text 时清除下拉 suggestion
            setSuggestionsState(() => ({
              commandArgumentHint: undefined,
              suggestions: [],
              selectedSuggestion: -1,
            }))
            setSuggestionType('none')
            setMaxColumnWidth(undefined)
            return
          }
        }
      }

      // Bash 模式历史 ghost text：
      // - 缓存已热 → 同步命中，与改前语义一致（命中则独占 ghost 并 return）
      // - 缓存未热 → 防抖异步加载，避免每键 await 扫 JSONL；未 return，后续仍可路径补全
      if (mode === 'bash' && value.trim()) {
        const syncMatch = getShellHistoryCompletionSync(value)
        if (syncMatch === undefined) {
          void debouncedBashHistoryGhost(value)
        } else if (syncMatch) {
          debouncedBashHistoryGhost.cancel()
          setInlineGhostText({
            text: syncMatch.suffix,
            fullCommand: syncMatch.fullCommand,
            insertPosition: value.length,
          })
          setSuggestionsState(() => ({
            commandArgumentHint: undefined,
            suggestions: [],
            selectedSuggestion: -1,
          }))
          setSuggestionType('none')
          setMaxColumnWidth(undefined)
          return
        } else {
          debouncedBashHistoryGhost.cancel()
          setInlineGhostText(undefined)
        }
      } else if (mode !== 'bash') {
        debouncedBashHistoryGhost.cancel()
      }

      // 检查 @ 以触发 team member / named subagent suggestion。
      // 必须先于 @ 文件符号检查以避免冲突；bash 模式下跳过，因为 @ 在 shell 命令中无特殊含义。
      const atMatch =
        mode !== 'bash' ? value.substring(0, effectiveCursorOffset).match(/(^|\s)@([\w-]*)$/) : null
      if (atMatch) {
        const partialName = (atMatch[2] ?? '').toLowerCase()
        // 命令式读取；调用时读取可避免会话中途新增 teammate/subagent 后数据过期。
        const state = store.getState()
        const members: SuggestionItem[] = []
        const seen = new Set<string>()
        if (isAgentSwarmsEnabled() && state.teamContext) {
          for (const t of Object.values(state.teamContext.teammates ?? {})) {
            if (t.name === TEAM_LEAD_NAME) {
              continue
            }
            if (!t.name.toLowerCase().startsWith(partialName)) {
              continue
            }
            seen.add(t.name)
            members.push({
              id: `dm-${t.name}`,
              displayText: `@${t.name}`,
              description: 'send message',
            })
          }
        }
        for (const [name, agentId] of state.agentNameRegistry) {
          if (seen.has(name)) {
            continue
          }
          if (!name.toLowerCase().startsWith(partialName)) {
            continue
          }
          const status = state.tasks[agentId]?.status
          members.push({
            id: `dm-${name}`,
            displayText: `@${name}`,
            description: status ? `send message · ${status}` : 'send message',
          })
        }
        if (members.length > 0) {
          debouncedFetchFileSuggestions.cancel()
          setSuggestionsState((prev) => ({
            commandArgumentHint: undefined,
            suggestions: members,
            selectedSuggestion: getPreservedSelection(
              prev.suggestions,
              prev.selectedSuggestion,
              members,
            ),
          }))
          setSuggestionType('agent')
          setMaxColumnWidth(undefined)
          return
        }
      }

      // 检查 # 以触发 Slack channel suggestion（需要 Slack MCP server）
      if (mode === 'prompt') {
        const hashMatch = value.substring(0, effectiveCursorOffset).match(HASH_CHANNEL_RE)
        if (hashMatch && hasSlackMcpServer(store.getState().mcp.clients)) {
          debouncedFetchSlackChannels(hashMatch[2]!)
          return
        } else if (suggestionType === 'slack-channel') {
          debouncedFetchSlackChannels.cancel()
          clearSuggestions()
        }
      }

      // 检查 @ 符号以触发文件 suggestion，包括带引号的路径；
      // MCP resource 还允许冒号（如 server:resource/path）。
      const hasAtSymbol = value.substring(0, effectiveCursorOffset).match(HAS_AT_SYMBOL_RE)

      // 先检查 slash command suggestion，其优先级高于 @ 符号。
      // 仅当光标不在 "/" 字符本身时显示 selector；光标位于行尾且前方为空白时也不显示。
      // bash 模式下不显示 slash command。
      const isAtEndWithWhitespace =
        effectiveCursorOffset === value.length &&
        effectiveCursorOffset > 0 &&
        value.length > 0 &&
        value[effectiveCursorOffset - 1] === ' '

      // 处理命令的目录补全
      if (mode === 'prompt' && isCommandInput(value) && effectiveCursorOffset > 0) {
        const parsedCommand = extractCommandNameAndArgs(value)
        if (parsedCommand && parsedCommand.commandName === 'add-dir' && parsedCommand.args) {
          const { args } = parsedCommand

          // args 以空白结尾时清除 suggestion，表示用户已完成路径输入
          if (args.match(/\s+$/)) {
            debouncedFetchFileSuggestions.cancel()
            clearSuggestions()
            return
          }
          const dirSuggestions = await getDirectoryCompletions(args)
          if (dirSuggestions.length > 0) {
            setSuggestionsState((prev) => ({
              suggestions: dirSuggestions,
              selectedSuggestion: getPreservedSelection(
                prev.suggestions,
                prev.selectedSuggestion,
                dirSuggestions,
              ),
              commandArgumentHint: undefined,
            }))
            setSuggestionType('directory')
            return
          }

          // 未找到 suggestion，清除后返回
          debouncedFetchFileSuggestions.cancel()
          clearSuggestions()
          return
        }

        // 处理 /resume 命令的自定义标题补全
        if (
          parsedCommand &&
          parsedCommand.commandName === 'resume' &&
          parsedCommand.args !== undefined &&
          value.includes(' ')
        ) {
          const { args } = parsedCommand

          // 通过部分匹配获取自定义标题 suggestion
          const matches = await searchSessionsByCustomTitle(args, {
            limit: 10,
          })
          const suggestions = matches.map((log) => {
            const sessionId = getSessionIdFromLog(log)
            return {
              id: `resume-title-${sessionId}`,
              displayText: log.customTitle!,
              description: formatLogMetadata(log),
              metadata: {
                sessionId,
              },
            }
          })
          if (suggestions.length > 0) {
            setSuggestionsState((prev) => ({
              suggestions,
              selectedSuggestion: getPreservedSelection(
                prev.suggestions,
                prev.selectedSuggestion,
                suggestions,
              ),
              commandArgumentHint: undefined,
            }))
            setSuggestionType('custom-title')
            return
          }

          // 未找到 suggestion，清除后返回
          clearSuggestions()
          return
        }
      }

      // 判断是否显示参数提示和命令 suggestion。
      if (
        mode === 'prompt' &&
        isCommandInput(value) &&
        effectiveCursorOffset > 0 &&
        !hasCommandWithArguments(isAtEndWithWhitespace, value)
      ) {
        let commandArgumentHint: string | undefined
        if (value.length > 1) {
          // 当前是没有参数的部分或完整命令，检查是否精确匹配命令且带参数提示

          // 提取命令名：/ 之后直到首个空格或末尾的内容
          const spaceIndex = value.indexOf(' ')
          const commandName = spaceIndex === -1 ? value.slice(1) : value.slice(1, spaceIndex)

          // 检查是否存在真实参数，即命令后有非空白内容
          const hasRealArguments =
            spaceIndex !== -1 && value.slice(spaceIndex + 1).trim().length > 0

          // 检查输入是否恰为“命令 + 单个空格”，即已准备输入参数
          const hasExactlyOneTrailingSpace = spaceIndex !== -1 && value.length === spaceIndex + 1

          // 命令后存在空格时不显示 suggestion，避免 Tab 补全后按 Enter 选中其他命令
          if (spaceIndex !== -1) {
            const exactMatch = commands.find((cmd) => getCommandName(cmd) === commandName)
            if (exactMatch || hasRealArguments) {
              // 优先级 1：静态 argumentHint，仅在首个尾随空格时显示以保持向后兼容
              if (exactMatch?.argumentHint && hasExactlyOneTrailingSpace) {
                commandArgumentHint = exactMatch.argumentHint
              }
              // 优先级 2：来自 argNames 的渐进提示，存在尾随空格时显示
              else if (
                exactMatch?.type === 'prompt' &&
                exactMatch.argNames?.length &&
                value.endsWith(' ')
              ) {
                const argsText = value.slice(spaceIndex + 1)
                const typedArgs = parseArguments(argsText)
                commandArgumentHint = generateProgressiveArgumentHint(
                  exactMatch.argNames,
                  typedArgs,
                )
              }
              setSuggestionsState(() => ({
                commandArgumentHint,
                suggestions: [],
                selectedSuggestion: -1,
              }))
              setSuggestionType('none')
              setMaxColumnWidth(undefined)
              return
            }
          }

          // 参数提示仅在恰好有一个尾随空格时显示，已在上方
          // hasExactlyOneTrailingSpace 为 true 时设置。
        }
        const commandItems = generateCommandSuggestions(value, commands)
        setSuggestionsState((prev) => ({
          commandArgumentHint,
          suggestions: commandItems,
          selectedSuggestion: getCommandSelectionForInputUpdate(
            previousInput,
            value,
            prev.suggestions,
            prev.selectedSuggestion,
            commandItems,
          ),
        }))
        setSuggestionType(commandItems.length > 0 ? 'command' : 'none')

        // 使用所有命令计算出的稳定宽度，避免过滤时布局偏移
        if (commandItems.length > 0) {
          setMaxColumnWidth(allCommandsMaxWidth)
        }
        return
      }
      if (suggestionType === 'command') {
        // 曾有命令 suggestion 但输入不再以 '/' 开头时需要清除；不能直接返回，
        // 因为仍可能存在相关 @ 符号和文件 suggestion。
        debouncedFetchFileSuggestions.cancel()
        clearSuggestions()
      } else if (isCommandInput(value) && hasCommandWithArguments(isAtEndWithWhitespace, value)) {
        // 命令已有参数且没有尾随空格时清除旧提示，避免状态切换时提示闪烁
        setSuggestionsState((prev) =>
          prev.commandArgumentHint
            ? {
                ...prev,
                commandArgumentHint: undefined,
              }
            : prev,
        )
      }
      if (suggestionType === 'custom-title') {
        // 曾有自定义标题 suggestion 但输入不再是 /resume 时清除。
        clearSuggestions()
      }
      if (
        suggestionType === 'agent' &&
        suggestionsRef.current.some((s: SuggestionItem) => s.id?.startsWith('dm-'))
      ) {
        // 曾有 team member suggestion 但输入不再包含 @ 时清除。
        const hasAt = value.substring(0, effectiveCursorOffset).match(/(^|\s)@([\w-]*)$/)
        if (!hasAt) {
          clearSuggestions()
        }
      }

      // 检查 @ 符号以触发文件和 MCP resource suggestion。
      // bash 模式下跳过 @ 自动补全，因为 @ 在 shell 命令中无特殊含义。
      if (hasAtSymbol && mode !== 'bash') {
        // 获取包含 @ 符号的 token
        const completionToken = extractCompletionToken(value, effectiveCursorOffset, true)
        if (completionToken?.token.startsWith('@')) {
          const searchToken = extractSearchToken(completionToken)

          // @ 后 token 类似路径时使用路径补全而非模糊搜索，
          // 处理 @~/path、@./path、@/path 等目录遍历情况
          if (isPathLikeToken(searchToken)) {
            latestPathTokenRef.current = searchToken
            const pathSuggestions = await getPathCompletions(searchToken, {
              maxResults: 10,
            })
            // 等待期间已有更新 query 发起时丢弃旧结果
            if (latestPathTokenRef.current !== searchToken) {
              return
            }
            if (pathSuggestions.length > 0) {
              setSuggestionsState((prev) => ({
                suggestions: pathSuggestions,
                selectedSuggestion: getPreservedSelection(
                  prev.suggestions,
                  prev.selectedSuggestion,
                  pathSuggestions,
                ),
                commandArgumentHint: undefined,
              }))
              setSuggestionType('directory')
              return
            }
          }

          // 已为完全相同 token 获取过时跳过，避免 suggestion 依赖重建
          // updateSuggestions 后形成循环。
          if (latestSearchTokenRef.current === searchToken) {
            return
          }
          void debouncedFetchFileSuggestions(searchToken, true)
          return
        }
      }

      // 存在活动文件 suggestion 或输入变化时，检查文件 suggestion
      if (suggestionType === 'file') {
        const completionToken = extractCompletionToken(value, effectiveCursorOffset, true)
        if (completionToken) {
          const searchToken = extractSearchToken(completionToken)
          // 已为完全相同 token 获取过时跳过
          if (latestSearchTokenRef.current === searchToken) {
            return
          }
          void debouncedFetchFileSuggestions(searchToken, false)
        } else {
          // 曾有文件 suggestion，但现在没有 completion token
          debouncedFetchFileSuggestions.cancel()
          clearSuggestions()
        }
      }

      // 非 bash 模式或输入已变化时清除 shell suggestion
      if (suggestionType === 'shell') {
        const inputSnapshot = (
          suggestionsRef.current[0]?.metadata as {
            inputSnapshot?: string
          }
        )?.inputSnapshot
        if (mode !== 'bash' || value !== inputSnapshot) {
          debouncedFetchFileSuggestions.cancel()
          clearSuggestions()
        }
      }
    },
    [
      suggestionType,
      commands,
      setSuggestionsState,
      clearSuggestions,
      debouncedFetchFileSuggestions,
      debouncedFetchSlackChannels,
      debouncedBashHistoryGhost,
      mode,
      suppressSuggestions,
      // 使用 suggestionsRef 而非 suggestions，避免只有 selectedSuggestion 变化、
      // suggestion 列表未变时重建此 callback。
      allCommandsMaxWidth,
    ],
  )

  // 输入变化时更新 suggestion。此处有意不依赖 cursorOffset，单纯移动光标不应重新触发；
  // 需要时通过 cursorOffsetRef 获取当前位置，且不造成重渲染。
  useEffect(() => {
    // 已针对完全相同输入关闭 suggestion 时不重新触发
    if (dismissedForInputRef.current === input) {
      return
    }
    // 实际输入文本变化而非仅重建 updateSuggestions 时，重置 search token ref，
    // 使同一 query 可重新获取。修复输入 @readme.md、清除、再输入后无 suggestion 的问题。
    const previousInput = prevInputRef.current
    if (previousInput !== input) {
      prevInputRef.current = input
      latestSearchTokenRef.current = null
      setHoveredSuggestionId(null)
    }
    // 输入变化时清除 dismissed 状态
    dismissedForInputRef.current = null
    void updateSuggestions(input, undefined, previousInput)
  }, [input, updateSuggestions])

  // 处理 Tab：补全 suggestion 或触发文件 suggestion
  const handleTab = useCallback(async () => {
    // 存在行内 ghost text 时应用
    if (effectiveGhostText) {
      // 先检查 bash 模式历史补全
      if (mode === 'bash') {
        // 用历史中的完整命令替换输入
        onInputChange(effectiveGhostText.fullCommand)
        setCursorOffset(effectiveGhostText.fullCommand.length)
        setInlineGhostText(undefined)
        return
      }

      // 查找行中命令并获取位置（prompt 模式）
      const midInputCommand = findMidInputSlashCommand(input, cursorOffset)
      if (midInputCommand) {
        // 用完整命令加空格替换部分命令
        const before = input.slice(0, midInputCommand.startPos)
        const after = input.slice(midInputCommand.startPos + midInputCommand.token.length)
        const newInput = `${before}/${effectiveGhostText.fullCommand} ${after}`
        const newCursorOffset =
          midInputCommand.startPos + 1 + effectiveGhostText.fullCommand.length + 1
        onInputChange(newInput)
        setCursorOffset(newCursorOffset)
        return
      }
    }

    // 存在活动 suggestion 时选择一项
    if (suggestions.length > 0) {
      // 取消待处理的 debounced fetch，避免接受时闪烁
      debouncedFetchFileSuggestions.cancel()
      debouncedFetchSlackChannels.cancel()
      const index = selectedSuggestion === -1 ? 0 : selectedSuggestion
      const suggestion = suggestions[index]
      if (suggestionType === 'command' && index < suggestions.length) {
        if (suggestion) {
          applyCommandSuggestion(
            suggestion,
            false,
            // Tab 时不执行
            commands,
            onInputChange,
            setCursorOffset,
            onSubmit,
          )
          clearSuggestions()
        }
      } else if (suggestionType === 'custom-title' && suggestions.length > 0) {
        // 将自定义标题应用到带 sessionId 的 /resume 命令
        if (suggestion) {
          const newInput = buildResumeInputFromSuggestion(suggestion)
          onInputChange(newInput)
          setCursorOffset(newInput.length)
          clearSuggestions()
        }
      } else if (suggestionType === 'directory' && suggestions.length > 0) {
        const suggestion = suggestions[index]
        if (suggestion) {
          // 检查是命令 context（如 /add-dir）还是通用路径补全
          const isInCommandContext = isCommandInput(input)
          let newInput: string
          if (isInCommandContext) {
            // 命令 context：只替换参数部分
            const spaceIndex = input.indexOf(' ')
            const commandPart = input.slice(0, spaceIndex + 1) // Include the space
            const cmdSuffix =
              isPathMetadata(suggestion.metadata) && suggestion.metadata.type === 'directory'
                ? '/'
                : ' '
            newInput = commandPart + suggestion.id + cmdSuffix
            onInputChange(newInput)
            setCursorOffset(newInput.length)
            if (isPathMetadata(suggestion.metadata) && suggestion.metadata.type === 'directory') {
              // 目录则为更新后的路径获取新 suggestion
              setSuggestionsState((prev) => ({
                ...prev,
                commandArgumentHint: undefined,
              }))
              void updateSuggestions(newInput, newInput.length, input)
            } else {
              clearSuggestions()
            }
          } else {
            // 通用路径补全：用带 @ 前缀的路径替换输入中的 path token；
            // 先尝试获取带 @ 前缀的 token，检查是否已有前缀。
            const completionTokenWithAt = extractCompletionToken(input, cursorOffset, true)
            const completionToken =
              completionTokenWithAt ?? extractCompletionToken(input, cursorOffset, false)
            if (completionToken) {
              const isDir =
                isPathMetadata(suggestion.metadata) && suggestion.metadata.type === 'directory'
              const result = applyDirectorySuggestion(
                input,
                suggestion.id,
                completionToken.startPos,
                completionToken.token.length,
                isDir,
              )
              newInput = result.newInput
              onInputChange(newInput)
              setCursorOffset(result.cursorPos)
              if (isDir) {
                // 目录则为更新后的路径获取新 suggestion
                setSuggestionsState((prev) => ({
                  ...prev,
                  commandArgumentHint: undefined,
                }))
                void updateSuggestions(newInput, result.cursorPos, input)
              } else {
                // 文件则清除 suggestion
                clearSuggestions()
              }
            } else {
              // 未找到 completion token（如光标位于空格后）时只清除 suggestion，
              // 不修改输入，避免数据丢失。
              clearSuggestions()
            }
          }
        }
      } else if (suggestionType === 'shell' && suggestions.length > 0) {
        const suggestion = suggestions[index]
        if (suggestion) {
          const metadata = suggestion.metadata as
            | {
                completionType: ShellCompletionType
              }
            | undefined
          applyShellSuggestion(
            suggestion,
            input,
            cursorOffset,
            onInputChange,
            setCursorOffset,
            metadata?.completionType,
          )
          clearSuggestions()
        }
      } else if (
        suggestionType === 'agent' &&
        suggestions.length > 0 &&
        suggestions[index]?.id?.startsWith('dm-')
      ) {
        const suggestion = suggestions[index]
        if (suggestion) {
          applyTriggerSuggestion(
            suggestion,
            input,
            cursorOffset,
            DM_MEMBER_RE,
            onInputChange,
            setCursorOffset,
          )
          clearSuggestions()
        }
      } else if (suggestionType === 'slack-channel' && suggestions.length > 0) {
        const suggestion = suggestions[index]
        if (suggestion) {
          applyTriggerSuggestion(
            suggestion,
            input,
            cursorOffset,
            HASH_CHANNEL_RE,
            onInputChange,
            setCursorOffset,
          )
          clearSuggestions()
        }
      } else if (suggestionType === 'file' && suggestions.length > 0) {
        const completionToken = extractCompletionToken(input, cursorOffset, true)
        if (!completionToken) {
          clearSuggestions()
          return
        }

        // 检查所有 suggestion 是否共享比当前输入更长的前缀
        const commonPrefix = findLongestCommonPrefix(suggestions)

        // 判断 token 是否以 @ 开头，以便替换时保留
        const hasAtPrefix = completionToken.token.startsWith('@')
        // 有 @ 和引号时，effective token 长度不包含它们
        let effectiveTokenLength: number
        if (completionToken.isQuoted) {
          // 移除 @" 前缀及可选结束引号，得到 effective length
          effectiveTokenLength = completionToken.token.slice(2).replace(/"$/, '').length
        } else if (hasAtPrefix) {
          effectiveTokenLength = completionToken.token.length - 1
        } else {
          effectiveTokenLength = completionToken.token.length
        }

        // 公共前缀长于用户已输入内容时，用公共前缀替换当前输入
        if (commonPrefix.length > effectiveTokenLength) {
          const replacementValue = formatReplacementValue({
            displayText: commonPrefix,
            mode,
            hasAtPrefix,
            needsQuotes: false,
            // 除非原本已有引号，否则公共前缀无需引号
            isQuoted: completionToken.isQuoted,
            isComplete: false, // partial completion
          })
          applyFileSuggestion(
            replacementValue,
            input,
            completionToken.token,
            completionToken.startPos,
            onInputChange,
            setCursorOffset,
          )
          // 不清除 suggestion，让用户继续输入或选择具体选项；改为按新前缀更新
          void updateSuggestions(
            input.replace(completionToken.token, replacementValue),
            cursorOffset,
            input,
          )
        } else if (index < suggestions.length) {
          // 否则应用选中的 suggestion
          const suggestion = suggestions[index]
          if (suggestion) {
            const needsQuotes = suggestion.displayText.includes(' ')
            const replacementValue = formatReplacementValue({
              displayText: suggestion.displayText,
              mode,
              hasAtPrefix,
              needsQuotes,
              isQuoted: completionToken.isQuoted,
              isComplete: true, // complete suggestion
            })
            applyFileSuggestion(
              replacementValue,
              input,
              completionToken.token,
              completionToken.startPos,
              onInputChange,
              setCursorOffset,
            )
            clearSuggestions()
          }
        }
      }
    } else if (input.trim() !== '') {
      let suggestionType: SuggestionType
      let suggestionItems: SuggestionItem[]
      if (mode === 'bash') {
        suggestionType = 'shell'
        // 此操作应很快，耗时小于 10ms
        const bashSuggestions = await generateBashSuggestions(input, cursorOffset)
        if (bashSuggestions.length === 1) {
          // 只有一个 suggestion 时立即应用
          const suggestion = bashSuggestions[0]
          if (suggestion) {
            const metadata = suggestion.metadata as
              | {
                  completionType: ShellCompletionType
                }
              | undefined
            applyShellSuggestion(
              suggestion,
              input,
              cursorOffset,
              onInputChange,
              setCursorOffset,
              metadata?.completionType,
            )
          }
          suggestionItems = []
        } else {
          suggestionItems = bashSuggestions
        }
      } else {
        suggestionType = 'file'
        // 没有 suggestion 时获取文件和 MCP resource suggestion
        const completionInfo = extractCompletionToken(input, cursorOffset, true)
        if (completionInfo) {
          // token 以 @ 开头时，去掉 @ 前缀搜索
          const isAtSymbol = completionInfo.token.startsWith('@')
          const searchToken = isAtSymbol ? completionInfo.token.substring(1) : completionInfo.token
          suggestionItems = await generateUnifiedSuggestions(
            searchToken,
            mcpResources,
            agents,
            isAtSymbol,
          )
        } else {
          suggestionItems = []
        }
      }
      if (suggestionItems.length > 0) {
        // 有多个 suggestion 或不在 bash 模式时显示列表
        setSuggestionsState((prev) => ({
          commandArgumentHint: undefined,
          suggestions: suggestionItems,
          selectedSuggestion: getPreservedSelection(
            prev.suggestions,
            prev.selectedSuggestion,
            suggestionItems,
          ),
        }))
        setSuggestionType(suggestionType)
        setMaxColumnWidth(undefined)
      }
    }
  }, [
    suggestions,
    selectedSuggestion,
    input,
    suggestionType,
    commands,
    mode,
    onInputChange,
    setCursorOffset,
    onSubmit,
    clearSuggestions,
    cursorOffset,
    updateSuggestions,
    mcpResources,
    setSuggestionsState,
    agents,
    debouncedFetchFileSuggestions,
    debouncedFetchSlackChannels,
    effectiveGhostText,
  ])

  // 按具体索引应用并执行候选。键盘 Enter 与鼠标点击共享这条路径，
  // 保证 command/file/agent 等补全行为一致。
  const acceptSuggestion = useCallback(
    (index: number) => {
      if (index < 0 || suggestions.length === 0) {
        return
      }
      const suggestion = suggestions[index]
      if (suggestionType === 'command' && index < suggestions.length) {
        if (suggestion) {
          applyCommandSuggestion(
            suggestion,
            true,
            // 回车/点击时执行命令
            commands,
            onInputChange,
            setCursorOffset,
            onSubmit,
          )
          debouncedFetchFileSuggestions.cancel()
          clearSuggestions()
        }
      } else if (suggestionType === 'custom-title' && index < suggestions.length) {
        // 应用自定义标题并执行带 sessionId 的 /resume 命令
        if (suggestion) {
          const newInput = buildResumeInputFromSuggestion(suggestion)
          onInputChange(newInput)
          setCursorOffset(newInput.length)
          onSubmit(newInput, /* isSubmittingSlashCommand */ true)
          debouncedFetchFileSuggestions.cancel()
          clearSuggestions()
        }
      } else if (suggestionType === 'shell' && index < suggestions.length) {
        const suggestion = suggestions[index]
        if (suggestion) {
          const metadata = suggestion.metadata as
            | {
                completionType: ShellCompletionType
              }
            | undefined
          applyShellSuggestion(
            suggestion,
            input,
            cursorOffset,
            onInputChange,
            setCursorOffset,
            metadata?.completionType,
          )
          debouncedFetchFileSuggestions.cancel()
          clearSuggestions()
        }
      } else if (
        suggestionType === 'agent' &&
        index < suggestions.length &&
        suggestion?.id?.startsWith('dm-')
      ) {
        applyTriggerSuggestion(
          suggestion,
          input,
          cursorOffset,
          DM_MEMBER_RE,
          onInputChange,
          setCursorOffset,
        )
        debouncedFetchFileSuggestions.cancel()
        clearSuggestions()
      } else if (suggestionType === 'slack-channel' && index < suggestions.length) {
        if (suggestion) {
          applyTriggerSuggestion(
            suggestion,
            input,
            cursorOffset,
            HASH_CHANNEL_RE,
            onInputChange,
            setCursorOffset,
          )
          debouncedFetchSlackChannels.cancel()
          clearSuggestions()
        }
      } else if (suggestionType === 'file' && index < suggestions.length) {
        // 需要时直接提取 completion token
        const completionInfo = extractCompletionToken(input, cursorOffset, true)
        if (completionInfo) {
          if (suggestion) {
            const hasAtPrefix = completionInfo.token.startsWith('@')
            const needsQuotes = suggestion.displayText.includes(' ')
            const replacementValue = formatReplacementValue({
              displayText: suggestion.displayText,
              mode,
              hasAtPrefix,
              needsQuotes,
              isQuoted: completionInfo.isQuoted,
              isComplete: true, // complete suggestion
            })
            applyFileSuggestion(
              replacementValue,
              input,
              completionInfo.token,
              completionInfo.startPos,
              onInputChange,
              setCursorOffset,
            )
            debouncedFetchFileSuggestions.cancel()
            clearSuggestions()
          }
        }
      } else if (suggestionType === 'directory' && index < suggestions.length) {
        if (suggestion) {
          // 命令 context（如 /add-dir）中，Enter 提交命令而非应用目录 suggestion。
          // 只清除 suggestion，让 submit handler 处理当前输入。
          if (isCommandInput(input)) {
            debouncedFetchFileSuggestions.cancel()
            clearSuggestions()
            return
          }

          // 通用路径补全：替换 path token
          const completionTokenWithAt = extractCompletionToken(input, cursorOffset, true)
          const completionToken =
            completionTokenWithAt ?? extractCompletionToken(input, cursorOffset, false)
          if (completionToken) {
            const isDir =
              isPathMetadata(suggestion.metadata) && suggestion.metadata.type === 'directory'
            const result = applyDirectorySuggestion(
              input,
              suggestion.id,
              completionToken.startPos,
              completionToken.token.length,
              isDir,
            )
            onInputChange(result.newInput)
            setCursorOffset(result.cursorPos)
          }
          // 未找到 completion token（如光标位于空格后）时不修改输入，以免数据丢失；
          // 只清除 suggestion。

          debouncedFetchFileSuggestions.cancel()
          clearSuggestions()
        }
      }
    },
    [
      suggestions,
      suggestionType,
      commands,
      input,
      cursorOffset,
      mode,
      onInputChange,
      setCursorOffset,
      onSubmit,
      clearSuggestions,
      debouncedFetchFileSuggestions,
      debouncedFetchSlackChannels,
    ],
  )

  // 鼠标点击建议：仅填入输入框，不立即执行，用户可编辑后回车发送。
  const onClickSuggestion = useCallback(
    (index: number) => {
      if (index < 0 || suggestions.length === 0) {
        return
      }
      const suggestion = suggestions[index]
      if (suggestionType === 'command' && index < suggestions.length) {
        if (suggestion) {
          applyCommandSuggestion(
            suggestion,
            false,
            // 点击不执行，仅填入输入框
            commands,
            onInputChange,
            setCursorOffset,
            onSubmit,
          )
          debouncedFetchFileSuggestions.cancel()
          clearSuggestions()
        }
      } else {
        // 非命令类型走默认行为
        acceptSuggestion(index)
      }
    },
    [
      suggestions,
      suggestionType,
      commands,
      onInputChange,
      setCursorOffset,
      onSubmit,
      clearSuggestions,
      debouncedFetchFileSuggestions,
      acceptSuggestion,
    ],
  )

  // 处理回车：应用并执行当前候选。
  const handleEnter = useCallback(() => {
    if (selectedSuggestion < 0 || suggestions.length === 0) {
      return
    }
    acceptSuggestion(selectedSuggestion)
  }, [acceptSuggestion, selectedSuggestion, suggestions.length])

  // autocomplete:accept 处理器：通过 Tab 或 Right Arrow 接受当前 suggestion
  const handleAutocompleteAccept = useCallback(() => {
    void handleTab()
  }, [handleTab])

  // autocomplete:dismiss 处理器：清除 suggestion 并阻止重新触发
  const handleAutocompleteDismiss = useCallback(() => {
    debouncedFetchFileSuggestions.cancel()
    debouncedFetchSlackChannels.cancel()
    clearSuggestions()
    // 关闭时记住输入，避免立即重新触发
    dismissedForInputRef.current = input
  }, [debouncedFetchFileSuggestions, debouncedFetchSlackChannels, clearSuggestions, input])

  // autocomplete:previous 处理器：选择上一项 suggestion
  const handleAutocompletePrevious = useCallback(() => {
    setHoveredSuggestionId(null)
    setSuggestionsState((prev) => ({
      ...prev,
      selectedSuggestion: getNextSuggestionIndex(
        prev.selectedSuggestion,
        suggestions.length,
        'previous',
      ),
    }))
  }, [suggestions.length, setSuggestionsState])

  // autocomplete:next 处理器：选择下一项 suggestion
  const handleAutocompleteNext = useCallback(() => {
    setHoveredSuggestionId(null)
    setSuggestionsState((prev) => ({
      ...prev,
      selectedSuggestion: getNextSuggestionIndex(
        prev.selectedSuggestion,
        suggestions.length,
        'next',
      ),
    }))
  }, [suggestions.length, setSuggestionsState])

  const onHoverSuggestion = useCallback((id: string | null) => {
    setHoveredSuggestionId(id)
  }, [])

  // Autocomplete context keybinding，仅在 suggestion 可见时生效
  const autocompleteHandlers = useMemo(
    () => ({
      'autocomplete:accept': handleAutocompleteAccept,
      'autocomplete:dismiss': handleAutocompleteDismiss,
      'autocomplete:previous': handleAutocompletePrevious,
      'autocomplete:next': handleAutocompleteNext,
    }),
    [
      handleAutocompleteAccept,
      handleAutocompleteDismiss,
      handleAutocompletePrevious,
      handleAutocompleteNext,
    ],
  )

  // 将 autocomplete 注册为 overlay，使 CancelRequestHandler 延后处理 ESC，
  // 确保先关闭 autocomplete，再取消运行中的任务。
  const isAutocompleteActive = suggestions.length > 0 || !!effectiveGhostText
  const isModalOverlayActive = useIsModalOverlayActive()
  useRegisterOverlay('autocomplete', isAutocompleteActive)
  // 注册 Autocomplete context，使其出现在其他处理器的 activeContexts 中，
  // 让 Chat resolver 能看到它，并将 up/down 交给其 binding。
  useRegisterKeybindingContext('Autocomplete', isAutocompleteActive)

  // modal overlay（如 DiffDialog）活跃时禁用 autocomplete keybinding，
  // 使 escape 到达 overlay 处理器，而不是关闭 autocomplete。
  useKeybindings(autocompleteHandlers, {
    context: 'Autocomplete',
    isActive: isAutocompleteActive && !isModalOverlayActive,
  })
  function acceptSuggestionText(text: string): void {
    const detectedMode = getModeFromInput(text)
    if (detectedMode !== 'prompt' && onModeChange) {
      onModeChange(detectedMode)
      const stripped = getValueFromInput(text)
      onInputChange(stripped)
      setCursorOffset(stripped.length)
    } else {
      onInputChange(text)
      setCursorOffset(text.length)
    }
  }

  // 处理 keybinding 未覆盖行为的键盘输入
  const handleKeyDown = (e: KeyboardEvent): void => {
    // 处理 Right Arrow 以接受 prompt suggestion ghost text
    if (e.key === 'right' && !isViewingTeammate) {
      const suggestionText = promptSuggestion.text
      const suggestionShownAt = promptSuggestion.shownAt
      if (suggestionText && suggestionShownAt > 0 && input === '') {
        markAccepted()
        acceptSuggestionText(suggestionText)
        e.stopImmediatePropagation()
        return
      }
    }

    // 没有 autocomplete suggestion 时处理 Tab fallback；按住 shift 时不处理，
    // 因为 shift+tab 用于模式循环。
    if (e.key === 'tab' && !e.shift) {
      // autocomplete 正在处理时跳过，即存在 suggestion 或 ghost text
      if (suggestions.length > 0 || effectiveGhostText) {
        return
      }
      // AppState 中存在 prompt suggestion 时接受
      const suggestionText = promptSuggestion.text
      const suggestionShownAt = promptSuggestion.shownAt
      if (suggestionText && suggestionShownAt > 0 && input === '' && !isViewingTeammate) {
        e.preventDefault()
        markAccepted()
        acceptSuggestionText(suggestionText)
        return
      }
      // 输入为空时提醒用户 thinking toggle 快捷键
      if (input.trim() === '') {
        e.preventDefault()
        addNotification({
          key: 'thinking-toggle-hint',
          jsx: <Text dimColor>Use {thinkingToggleShortcut} to toggle thinking</Text>,
          priority: 'immediate',
          timeoutMs: 3000,
        })
      }
      return
    }

    // 仅在存在 suggestion 时继续导航
    if (suggestions.length === 0) {
      return
    }

    // BaseTextInput 的监听器先于父级 autocomplete 注册。通常 keybinding
    // 会消费 ↑/↓；若上下文解析没有命中，必须在这里兜底，不能让按键静默丢失。
    if (
      handleAutocompleteArrowFallback(
        e,
        suggestions.length > 0,
        handleAutocompletePrevious,
        handleAutocompleteNext,
      )
    ) {
      return
    }

    // 用 Ctrl-N/P 导航，方向键由 keybinding 处理。处于 chord sequence 中时跳过，
    // 以允许 ctrl+f n 等 chord。
    const hasPendingChord = keybindingContext?.pendingChord != null
    if (e.ctrl && e.key === 'n' && !hasPendingChord) {
      e.preventDefault()
      handleAutocompleteNext()
      return
    }
    if (e.ctrl && e.key === 'p' && !hasPendingChord) {
      e.preventDefault()
      handleAutocompletePrevious()
      return
    }

    // 通过 return/enter 处理选择和执行。Shift+Enter 与 Meta+Enter 由 useTextInput
    // 插入换行，因此这些组合不接受 suggestion。
    if (e.key === 'return' && !e.shift && !e.meta) {
      e.preventDefault()
      handleEnter()
    }
  }

  // 向后兼容 bridge：PromptInput 尚未将 handleKeyDown 接到 <Box onKeyDown>。
  // 在 consumer 通过独立 PR 迁移前，先用 useInput 订阅并适配 InputEvent → KeyboardEvent。
  // TODO(onKeyDown-migration)：PromptInput 传入 handleKeyDown 后移除。
  useInput((_input, _key, event) => {
    const kbEvent = new KeyboardEvent(event.keypress)
    handleKeyDown(kbEvent)
    if (kbEvent.didStopImmediatePropagation()) {
      event.stopImmediatePropagation()
    }
  })
  return {
    suggestions,
    selectedSuggestion,
    hoveredSuggestionId,
    suggestionType,
    maxColumnWidth,
    commandArgumentHint,
    inlineGhostText: effectiveGhostText,
    handleKeyDown,
    acceptSuggestion,
    onClickSuggestion,
    onHoverSuggestion,
  }
}
