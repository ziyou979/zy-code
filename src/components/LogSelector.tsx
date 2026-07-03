import { fig } from '../constants/figures.js'
import chalk from 'chalk'
import React from 'react'
import { getOriginalCwd, getSessionId } from '../bootstrap/state.js'
import { useModalOrTerminalSize } from '../context/modalContext.js'
import { useExitOnCtrlCDWithKeybindings } from '../hooks/useExitOnCtrlCDWithKeybindings.js'
import { useSearchInput } from '../hooks/useSearchInput.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { tSync } from '../i18n/index.js'
import { applyColor } from '../ink/colorize.js'
import type { Color } from '../ink/styles.js'
import { Box, Text, useInput, useTerminalFocus, useTheme } from '../ink.js'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import { logEvent } from '../services/analytics/index.js'
import type { LogOption, SerializedMessage } from '../types/logs.js'
import { formatLogMetadata, truncateToWidth } from '../utils/format.js'
import { getWorktreePaths } from '../utils/getWorktreePaths.js'
import { getBranch } from '../utils/git.js'
import { getLogDisplayTitle } from '../utils/log.js'
import {
  getFirstMeaningfulUserMessageTextContent,
  getSessionIdFromLog,
  isCustomTitleEnabled,
  saveCustomTitle,
} from '../utils/sessionStorage.js'
import { getTheme } from '../utils/theme.js'
import { ConfigurableShortcutHint } from './ConfigurableShortcutHint.js'
import { Select } from './CustomSelect/select.js'
import { Byline } from './design-system/Byline.js'
import { Divider } from './design-system/Divider.js'
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js'
import { SearchBox } from './SearchBox.js'
import { SessionPreview } from './SessionPreview.js'
import { Spinner } from './Spinner.js'
import { TagTabs } from './TagTabs.js'
import TextInput from './TextInput.js'
import { type TreeNode, TreeSelect } from './ui/TreeSelect.js'

type AgenticSearchState =
  | {
      status: 'idle'
    }
  | {
      status: 'searching'
    }
  | {
      status: 'results'
      results: LogOption[]
      query: string
    }
  | {
      status: 'error'
      message: string
    }
export type LogSelectorProps = {
  logs: LogOption[]
  maxHeight?: number
  forceWidth?: number
  onCancel?: () => void
  onSelect: (log: LogOption) => void
  onLogsChanged?: () => void
  onLoadMore?: (count: number) => void
  initialSearchQuery?: string
  showAllProjects?: boolean
  onToggleAllProjects?: () => void
  onAgenticSearch?: (query: string, logs: LogOption[], signal?: AbortSignal) => Promise<LogOption[]>
}
type LogTreeNode = TreeNode<{
  log: LogOption
  indexInFiltered: number
}>
function normalizeAndTruncateToWidth(text: string, maxWidth: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return truncateToWidth(normalized, maxWidth)
}

// Width of prefixes that TreeSelect will add
const PARENT_PREFIX_WIDTH = 2 // '▼ ' or '▶ '
const CHILD_PREFIX_WIDTH = 4 // '  ▸ '

// Deep search constants
const DEEP_SEARCH_MAX_MESSAGES = 2000
const DEEP_SEARCH_CROP_SIZE = 1000
const DEEP_SEARCH_MAX_TEXT_LENGTH = 50000 // Cap searchable text per session
const _FUSE_THRESHOLD = 0.3
const DATE_TIE_THRESHOLD_MS = 60 * 1000 // 1 minute - use relevance as tie-breaker within this window
const SNIPPET_CONTEXT_CHARS = 50 // Characters to show before/after match

type Snippet = {
  before: string
  match: string
  after: string
}
function formatSnippet(
  { before, match, after }: Snippet,
  highlightColor: (text: string) => string,
): string {
  return chalk.dim(before) + highlightColor(match) + chalk.dim(after)
}
function extractSnippet(text: string, query: string, contextChars: number): Snippet | null {
  // Find exact query occurrence (case-insensitive).
  // Note: Fuse does fuzzy matching, so this may miss some fuzzy matches.
  // This is acceptable for now - in the future we could use Fuse's includeMatches
  // option and work with the match indices directly.
  const matchIndex = text.toLowerCase().indexOf(query.toLowerCase())
  if (matchIndex === -1) {
    return null
  }
  const matchEnd = matchIndex + query.length
  const snippetStart = Math.max(0, matchIndex - contextChars)
  const snippetEnd = Math.min(text.length, matchEnd + contextChars)
  const beforeRaw = text.slice(snippetStart, matchIndex)
  const matchText = text.slice(matchIndex, matchEnd)
  const afterRaw = text.slice(matchEnd, snippetEnd)
  return {
    before: (snippetStart > 0 ? '…' : '') + beforeRaw.replace(/\s+/g, ' ').trimStart(),
    match: matchText.trim(),
    after: afterRaw.replace(/\s+/g, ' ').trimEnd() + (snippetEnd < text.length ? '…' : ''),
  }
}
function buildLogLabel(
  log: LogOption,
  maxLabelWidth: number,
  options?: {
    isGroupHeader?: boolean
    isChild?: boolean
    forkCount?: number
    shortId?: string
  },
): string {
  const { isGroupHeader = false, isChild = false, forkCount = 0, shortId } = options || {}

  // TreeSelect will add the prefix, so we just need to account for its width
  const prefixWidth =
    isGroupHeader && forkCount > 0 ? PARENT_PREFIX_WIDTH : isChild ? CHILD_PREFIX_WIDTH : 0
  const sessionCountSuffix =
    isGroupHeader && forkCount > 0
      ? ` (+${forkCount} other ${forkCount === 1 ? 'session' : 'sessions'})`
      : ''
  const sidechainSuffix = log.isSidechain ? ` ${tSync('logSelector.sidechain')}` : ''
  // 标题撞车时附加 sessionId 短码以区分(仅在调用方判定为重复标题时传入)
  const shortIdSuffix = shortId ? ` (${shortId})` : ''
  const maxSummaryWidth =
    maxLabelWidth -
    prefixWidth -
    sidechainSuffix.length -
    sessionCountSuffix.length -
    shortIdSuffix.length
  const truncatedSummary = normalizeAndTruncateToWidth(getLogDisplayTitle(log), maxSummaryWidth)
  return `${truncatedSummary}${shortIdSuffix}${sidechainSuffix}${sessionCountSuffix}`
}
function buildLogMetadata(
  log: LogOption,
  options?: {
    isChild?: boolean
    showProjectPath?: boolean
  },
): string {
  const { isChild = false, showProjectPath = false } = options || {}
  // Match the child prefix width for proper alignment
  const childPadding = isChild ? '    ' : '' // 4 spaces to match '  ▸ '
  const baseMetadata = formatLogMetadata(log)
  const projectSuffix = showProjectPath && log.projectPath ? ` · ${log.projectPath}` : ''
  return childPadding + baseMetadata + projectSuffix
}
export function LogSelector({
  logs,
  maxHeight = Infinity,
  forceWidth,
  onCancel,
  onSelect,
  onLogsChanged,
  onLoadMore,
  initialSearchQuery,
  showAllProjects = false,
  onToggleAllProjects,
  onAgenticSearch,
}: LogSelectorProps) {
  const terminalSize = useTerminalSize()
  const modalAwareSize = useModalOrTerminalSize(terminalSize)
  const columns = forceWidth || modalAwareSize.columns
  const exitState = useExitOnCtrlCDWithKeybindings(onCancel)
  const isTerminalFocused = useTerminalFocus()
  const isResumeWithRenameEnabled = isCustomTitleEnabled()
  const _isDeepSearchEnabled = false
  const [themeName] = useTheme()
  const theme = getTheme(themeName)
  const highlightColor = (text: string) => applyColor(text, theme.warning as Color)
  const _isAgenticSearchEnabled = false
  const [currentBranch, setCurrentBranch] = React.useState<string | null>(null)
  const [branchFilterEnabled, setBranchFilterEnabled] = React.useState(false)
  const [showAllWorktrees, setShowAllWorktrees] = React.useState(false)
  const [hasMultipleWorktrees, setHasMultipleWorktrees] = React.useState(false)
  const currentCwd = getOriginalCwd()
  const [renameValue, setRenameValue] = React.useState('')
  const [renameCursorOffset, setRenameCursorOffset] = React.useState(0)
  const initialExpandedSet = new Set()
  const [expandedGroupSessionIds, setExpandedGroupSessionIds] = React.useState(initialExpandedSet)
  const [focusedNode, setFocusedNode] = React.useState<LogTreeNode | null>(null)
  const [focusedIndex, setFocusedIndex] = React.useState(1)
  const [viewMode, setViewMode] = React.useState('list')
  const [previewLog, setPreviewLog] = React.useState<LogOption | null>(null)
  const prevFocusedIdRef = React.useRef<string | null>(null)
  const [selectedTagIndex, setSelectedTagIndex] = React.useState(0)
  const [agenticSearchState, setAgenticSearchState] = React.useState<AgenticSearchState>({
    status: 'idle',
  })
  const [isAgenticSearchOptionFocused, setIsAgenticSearchOptionFocused] = React.useState(false)
  const agenticSearchAbortRef = React.useRef<AbortController | null>(null)
  const {
    query: searchQuery,
    setQuery: setSearchQuery,
    cursorOffset: searchCursorOffset,
  } = useSearchInput({
    isActive: viewMode === 'search' && agenticSearchState.status !== 'searching',
    onExit: () => {
      setViewMode('list')
      logEvent('zy_session_search_toggled', {
        enabled: false,
      })
    },
    onExitUp: () => {
      setViewMode('list')
      logEvent('zy_session_search_toggled', {
        enabled: false,
      })
    },
    passthroughCtrlKeys: ['n'],
    initialQuery: initialSearchQuery || '',
  })
  const deferredSearchQuery = React.useDeferredValue(searchQuery)
  const [debouncedDeepSearchQuery, setDebouncedDeepSearchQuery] = React.useState('')
  React.useEffect(() => {
    if (!deferredSearchQuery) {
      setDebouncedDeepSearchQuery('')
      return
    }
    const timeoutId = setTimeout(setDebouncedDeepSearchQuery, 300, deferredSearchQuery)
    return () => clearTimeout(timeoutId)
  }, [deferredSearchQuery])
  const [deepSearchResults, setDeepSearchResults] = React.useState<{
    query: string
    results: Array<{ log: LogOption; score?: number; searchableText?: string }>
  } | null>(null)
  const [isSearching, setIsSearching] = React.useState(false)
  React.useEffect(() => {
    getBranch().then((branch) => setCurrentBranch(branch))
    getWorktreePaths(currentCwd).then((paths) => {
      setHasMultipleWorktrees(paths.length > 1)
    })
  }, [currentCwd])
  const _searchableTextByLog = new Map(logs.map((log) => [log, buildSearchableText(log)]))

  const uniqueTags = getUniqueTags(logs)
  const hasTags = uniqueTags.length > 0
  const tagTabs = hasTags ? ['All', ...uniqueTags] : []
  const effectiveTagIndex =
    tagTabs.length > 0 && selectedTagIndex < tagTabs.length ? selectedTagIndex : 0
  const selectedTab = tagTabs[effectiveTagIndex]
  const tagFilter = selectedTab === 'All' ? undefined : selectedTab
  const tagTabsLines = hasTags ? 1 : 0
  let filtered = logs
  if (isResumeWithRenameEnabled) {
    filtered = logs.filter((log_1) => {
      const currentSessionId = getSessionId()
      const logSessionId = getSessionIdFromLog(log_1)
      const isCurrentSession = currentSessionId && logSessionId === currentSessionId
      if (isCurrentSession) {
        return true
      }
      if (log_1.customTitle) {
        return true
      }
      const fromMessages = getFirstMeaningfulUserMessageTextContent(log_1.messages)
      if (fromMessages) {
        return true
      }
      if (log_1.firstPrompt || log_1.customTitle) {
        return true
      }
      return false
    })
  }
  if (tagFilter !== undefined) {
    filtered = filtered.filter((log_2) => log_2.tag === tagFilter)
  }
  if (branchFilterEnabled && currentBranch) {
    filtered = filtered.filter((log_3) => log_3.gitBranch === currentBranch)
  }
  if (hasMultipleWorktrees && !showAllWorktrees) {
    filtered = filtered.filter((log_4) => log_4.projectPath === currentCwd)
  }
  const baseFilteredLogs = filtered
  let titleFilteredLogs
  if (!searchQuery) {
    titleFilteredLogs = baseFilteredLogs
  } else {
    const query = searchQuery.toLowerCase()
    titleFilteredLogs = baseFilteredLogs.filter((log_5) => {
      const displayedTitle = getLogDisplayTitle(log_5).toLowerCase()
      const branch_0 = (log_5.gitBranch || '').toLowerCase()
      const tag = (log_5.tag || '').toLowerCase()
      const prInfo = log_5.prNumber
        ? `pr #${log_5.prNumber} ${log_5.prRepository || ''}`.toLowerCase()
        : ''
      return (
        displayedTitle.includes(query) ||
        branch_0.includes(query) ||
        tag.includes(query) ||
        prInfo.includes(query)
      )
    })
  }
  React.useEffect(() => {
    if (false && deferredSearchQuery && deferredSearchQuery !== debouncedDeepSearchQuery) {
      setIsSearching(true)
    }
  }, [deferredSearchQuery, debouncedDeepSearchQuery])
  React.useEffect(() => {
    setDeepSearchResults(null)
    setIsSearching(false)
    return
    const timeoutId_0 = setTimeout(
      (
        fuseIndex_0: {
          search(
            q: string,
          ): Array<{ item: { log: LogOption; searchableText?: string }; score?: number }>
        },
        debouncedDeepSearchQuery_0: string,
        setDeepSearchResults_0: typeof setDeepSearchResults,
        setIsSearching_0: typeof setIsSearching,
      ) => {
        const results = fuseIndex_0.search(debouncedDeepSearchQuery_0)
        results.sort(
          (
            a: { item: { log: LogOption }; score?: number },
            b: { item: { log: LogOption }; score?: number },
          ) => {
            const aTime = new Date(a.item.log.modified).getTime()
            const bTime = new Date(b.item.log.modified).getTime()
            const timeDiff = bTime - aTime
            if (Math.abs(timeDiff) > DATE_TIE_THRESHOLD_MS) {
              return timeDiff
            }
            return (a.score ?? 1) - (b.score ?? 1)
          },
        )
        setDeepSearchResults_0({
          results: results.map(
            (r: { item: { log: LogOption; searchableText?: string }; score?: number }) => ({
              log: r.item.log,
              score: r.score,
              searchableText: r.item.searchableText,
            }),
          ),
          query: debouncedDeepSearchQuery_0,
        })
        setIsSearching_0(false)
      },
      0,
      null,
      debouncedDeepSearchQuery,
      setDeepSearchResults,
      setIsSearching,
    )
    return () => {
      clearTimeout(timeoutId_0)
    }
  }, [debouncedDeepSearchQuery])
  let filtered_0 = titleFilteredLogs
  const snippetMap = new Map()
  if (
    deepSearchResults &&
    debouncedDeepSearchQuery &&
    deepSearchResults.query === debouncedDeepSearchQuery
  ) {
    for (const result of deepSearchResults.results) {
      if (result.searchableText) {
        const snippet = extractSnippet(
          result.searchableText,
          debouncedDeepSearchQuery,
          SNIPPET_CONTEXT_CHARS,
        )
        if (snippet) {
          snippetMap.set(result.log, snippet)
        }
      }
    }
    const titleMatchIds = new Set(filtered_0.map((log_6) => log_6.messages[0]?.uuid))
    const transcriptOnlyMatches = deepSearchResults.results
      .map((r_0) => r_0.log)
      .filter((log_7) => !titleMatchIds.has(log_7.messages[0]?.uuid))
    filtered_0 = [...filtered_0, ...transcriptOnlyMatches]
  }
  const { filteredLogs, snippets } = {
    filteredLogs: filtered_0,
    snippets: snippetMap,
  }
  let displayedLogs
  if (agenticSearchState.status === 'results' && agenticSearchState.results.length > 0) {
    displayedLogs = agenticSearchState.results
  } else {
    displayedLogs = filteredLogs
  }
  const maxLabelWidth = Math.max(30, columns - 4)
  let treeNodes: LogTreeNode[]
  if (!isResumeWithRenameEnabled) {
    treeNodes = []
  } else {
    const sessionGroups = groupLogsBySessionId(displayedLogs)
    // 不同会话(sessionId)若展示标题相同,在标题后附加 sessionId 短码以便区分
    const duplicateGroupTitles = computeDuplicateGroupTitles(sessionGroups)
    treeNodes = Array.from(sessionGroups.entries()).map((entry) => {
      const [sessionId, groupLogs] = entry
      const latestLog = groupLogs[0]
      const indexInFiltered = displayedLogs.indexOf(latestLog)
      const groupShortId = duplicateGroupTitles.has(getLogDisplayTitle(latestLog))
        ? sessionId.slice(0, 8)
        : undefined
      const snippet_0 = snippets.get(latestLog)
      const snippetStr = snippet_0 ? formatSnippet(snippet_0, highlightColor) : null
      if (groupLogs.length === 1) {
        const metadata = buildLogMetadata(latestLog, {
          showProjectPath: showAllProjects,
        })
        return {
          id: `log:${sessionId}:0`,
          value: {
            log: latestLog,
            indexInFiltered,
          },
          label: buildLogLabel(latestLog, maxLabelWidth, { shortId: groupShortId }),
          description: snippetStr ? `${metadata}\n  ${snippetStr}` : metadata,
          dimDescription: true,
        }
      }
      const forkCount = groupLogs.length - 1
      const children = groupLogs.slice(1).map((log_8, index) => {
        const childIndexInFiltered = displayedLogs.indexOf(log_8)
        const childSnippet = snippets.get(log_8)
        const childSnippetStr = childSnippet ? formatSnippet(childSnippet, highlightColor) : null
        const childMetadata = buildLogMetadata(log_8, {
          isChild: true,
          showProjectPath: showAllProjects,
        })
        return {
          id: `log:${sessionId}:${index + 1}`,
          value: {
            log: log_8,
            indexInFiltered: childIndexInFiltered,
          },
          label: buildLogLabel(log_8, maxLabelWidth, {
            isChild: true,
          }),
          description: childSnippetStr
            ? `${childMetadata}\n      ${childSnippetStr}`
            : childMetadata,
          dimDescription: true,
        }
      })
      const parentMetadata = buildLogMetadata(latestLog, {
        showProjectPath: showAllProjects,
      })
      return {
        id: `group:${sessionId}`,
        value: {
          log: latestLog,
          indexInFiltered,
        },
        label: buildLogLabel(latestLog, maxLabelWidth, {
          isGroupHeader: true,
          forkCount,
          shortId: groupShortId,
        }),
        description: snippetStr ? `${parentMetadata}\n  ${snippetStr}` : parentMetadata,
        dimDescription: true,
        children,
      }
    })
  }
  let flatOptions: Array<{
    label: string
    description: string
    dimDescription: boolean
    value: string
  }>
  if (isResumeWithRenameEnabled) {
    flatOptions = []
  } else {
    flatOptions = displayedLogs.map((log_9, index_0) => {
      const rawSummary = getLogDisplayTitle(log_9)
      const summaryWithSidechain =
        rawSummary + (log_9.isSidechain ? ` ${tSync('logSelector.sidechain')}` : '')
      const summary = normalizeAndTruncateToWidth(summaryWithSidechain, maxLabelWidth)
      const baseDescription = formatLogMetadata(log_9)
      const projectSuffix = showAllProjects && log_9.projectPath ? ` · ${log_9.projectPath}` : ''
      const snippet_1 = snippets.get(log_9)
      const snippetStr_0 = snippet_1 ? formatSnippet(snippet_1, highlightColor) : null
      return {
        label: summary,
        description: snippetStr_0
          ? `${baseDescription}${projectSuffix}\n  ${snippetStr_0}`
          : baseDescription + projectSuffix,
        dimDescription: true,
        value: index_0.toString(),
      }
    })
  }
  const focusedLog = focusedNode?.value.log ?? null
  const getExpandCollapseHint = () => {
    if (!isResumeWithRenameEnabled || !focusedLog) {
      return ''
    }
    const sessionId_0 = getSessionIdFromLog(focusedLog)
    if (!sessionId_0) {
      return ''
    }
    const sessionLogs = displayedLogs.filter(
      (log_10) => getSessionIdFromLog(log_10) === sessionId_0,
    )
    const hasMultipleLogs = sessionLogs.length > 1
    if (!hasMultipleLogs) {
      return ''
    }
    const isExpanded = expandedGroupSessionIds.has(sessionId_0)
    const isChildNode = sessionLogs.indexOf(focusedLog) > 0
    if (isChildNode) {
      return tSync('logSelector.collapseHint')
    }
    return isExpanded ? tSync('logSelector.collapseHint') : tSync('logSelector.expandHint')
  }
  const handleRenameSubmit = async () => {
    const sessionId_1 = focusedLog ? getSessionIdFromLog(focusedLog) : undefined
    if (!focusedLog || !sessionId_1) {
      setViewMode('list')
      setRenameValue('')
      return
    }
    if (renameValue.trim()) {
      await saveCustomTitle(sessionId_1, renameValue.trim(), focusedLog.fullPath)
      if (isResumeWithRenameEnabled && onLogsChanged) {
        onLogsChanged()
      }
    }
    setViewMode('list')
    setRenameValue('')
  }
  const exitSearchMode = () => {
    setViewMode('list')
    logEvent('zy_session_search_toggled', {
      enabled: false,
    })
  }
  const enterSearchMode = () => {
    setViewMode('search')
    logEvent('zy_session_search_toggled', {
      enabled: true,
    })
  }
  const handleAgenticSearch = async () => {
    if (!searchQuery.trim() || !onAgenticSearch) {
      return
    }
    agenticSearchAbortRef.current?.abort()
    const abortController = new AbortController()
    agenticSearchAbortRef.current = abortController
    setAgenticSearchState({
      status: 'searching',
    })
    logEvent('zy_agentic_search_started', {
      query_length: searchQuery.length,
    })
    try {
      const results_0 = await onAgenticSearch!(searchQuery, logs, abortController.signal)
      if (abortController.signal.aborted) {
        return
      }
      setAgenticSearchState({
        status: 'results',
        results: results_0,
        query: searchQuery,
      })
      logEvent('zy_agentic_search_completed', {
        query_length: searchQuery.length,
        results_count: results_0.length,
      })
    } catch (error: unknown) {
      if (abortController.signal.aborted) {
        return
      }
      setAgenticSearchState({
        status: 'error',
        message: (error as Error)?.message ?? tSync('logSelector.searchFailed'),
      })
      logEvent('zy_agentic_search_error', {
        query_length: searchQuery.length,
      })
    }
  }
  React.useEffect(() => {
    if (agenticSearchState.status !== 'idle' && agenticSearchState.status !== 'searching') {
      if (
        (agenticSearchState.status === 'results' && agenticSearchState.query !== searchQuery) ||
        agenticSearchState.status === 'error'
      ) {
        setAgenticSearchState({
          status: 'idle',
        })
      }
    }
  }, [searchQuery, agenticSearchState])
  React.useEffect(
    () => () => {
      agenticSearchAbortRef.current?.abort()
    },
    [],
  )
  const prevAgenticStatusRef = React.useRef(agenticSearchState.status)
  React.useEffect(() => {
    const prevStatus = prevAgenticStatusRef.current
    prevAgenticStatusRef.current = agenticSearchState.status
    if (prevStatus === 'searching' && agenticSearchState.status === 'results') {
      if (isResumeWithRenameEnabled && treeNodes.length > 0) {
        setFocusedNode(treeNodes[0])
      } else {
        if (!isResumeWithRenameEnabled && displayedLogs.length > 0) {
          const firstLog = displayedLogs[0]
          setFocusedNode({
            id: '0',
            value: {
              log: firstLog,
              indexInFiltered: 0,
            },
            label: '',
          })
        }
      }
    }
  }, [agenticSearchState.status, isResumeWithRenameEnabled, treeNodes, displayedLogs])
  const handleFlatOptionsSelectFocus = (value: string) => {
    const index_1 = parseInt(value, 10)
    const log_11 = displayedLogs[index_1]
    if (!log_11 || prevFocusedIdRef.current === index_1.toString()) {
      return
    }
    prevFocusedIdRef.current = index_1.toString()
    setFocusedNode({
      id: index_1.toString(),
      value: {
        log: log_11,
        indexInFiltered: index_1,
      },
      label: '',
    })
    setFocusedIndex(index_1 + 1)
  }
  const handleTreeSelectFocus = (node: LogTreeNode) => {
    setFocusedNode(node)
    const index_2 = displayedLogs.findIndex(
      (log_12) => getSessionIdFromLog(log_12) === getSessionIdFromLog(node.value.log),
    )
    if (index_2 >= 0) {
      setFocusedIndex(index_2 + 1)
    }
  }
  useKeybinding(
    'confirm:no',
    () => {
      agenticSearchAbortRef.current?.abort()
      setAgenticSearchState({
        status: 'idle',
      })
      logEvent('zy_agentic_search_cancelled', {})
    },
    {
      context: 'Confirmation',
      isActive: viewMode !== 'preview' && agenticSearchState.status === 'searching',
    },
  )
  useKeybinding(
    'confirm:no',
    () => {
      setViewMode('list')
      setRenameValue('')
    },
    {
      context: 'Settings',
      isActive: viewMode === 'rename' && agenticSearchState.status !== 'searching',
    },
  )
  useKeybinding(
    'confirm:no',
    () => {
      setSearchQuery('')
      setIsAgenticSearchOptionFocused(false)
      onCancel?.()
    },
    {
      context: 'Confirmation',
      isActive:
        viewMode !== 'preview' &&
        viewMode !== 'rename' &&
        viewMode !== 'search' &&
        isAgenticSearchOptionFocused &&
        agenticSearchState.status !== 'searching',
    },
  )
  useInput(
    (input, key) => {
      if (viewMode === 'preview') {
        return
      }
      if (agenticSearchState.status === 'searching') {
        return
      }
      if (viewMode === 'rename') {
      } else {
        if (viewMode === 'search') {
          if (input.toLowerCase() === 'n' && key.ctrl) {
            exitSearchMode()
          } else {
            if (key.return || key.downArrow) {
              if (
                searchQuery.trim() &&
                onAgenticSearch &&
                false &&
                agenticSearchState.status !== 'results'
              ) {
                setIsAgenticSearchOptionFocused(true)
              }
            }
          }
        } else {
          if (isAgenticSearchOptionFocused) {
            if (key.return) {
              handleAgenticSearch()
              setIsAgenticSearchOptionFocused(false)
              return
            } else {
              if (key.downArrow) {
                setIsAgenticSearchOptionFocused(false)
                return
              } else {
                if (key.upArrow) {
                  setViewMode('search')
                  setIsAgenticSearchOptionFocused(false)
                  return
                }
              }
            }
          }
          if (hasTags && key.tab) {
            const offset = key.shift ? -1 : 1
            setSelectedTagIndex((prev) => {
              const current = prev < tagTabs.length ? prev : 0
              const newIndex = (current + tagTabs.length + offset) % tagTabs.length
              const newTab = tagTabs[newIndex]
              logEvent('zy_session_tag_filter_changed', {
                is_all: newTab === 'All',
                tag_count: uniqueTags.length,
              })
              return newIndex
            })
            return
          }
          const keyIsNotCtrlOrMeta = !key.ctrl && !key.meta
          const lowerInput = input.toLowerCase()
          if (lowerInput === 'a' && key.ctrl && onToggleAllProjects) {
            onToggleAllProjects()
            logEvent('zy_session_all_projects_toggled', {
              enabled: !showAllProjects,
            })
          } else {
            if (lowerInput === 'b' && key.ctrl) {
              const newEnabled = !branchFilterEnabled
              setBranchFilterEnabled(newEnabled)
              logEvent('zy_session_branch_filter_toggled', {
                enabled: newEnabled,
              })
            } else {
              if (lowerInput === 'w' && key.ctrl && hasMultipleWorktrees) {
                const newValue = !showAllWorktrees
                setShowAllWorktrees(newValue)
                logEvent('zy_session_worktree_filter_toggled', {
                  enabled: newValue,
                })
              } else {
                if (lowerInput === '/' && keyIsNotCtrlOrMeta) {
                  setViewMode('search')
                  logEvent('zy_session_search_toggled', {
                    enabled: true,
                  })
                } else {
                  if (lowerInput === 'r' && key.ctrl && focusedLog) {
                    setViewMode('rename')
                    setRenameValue('')
                    logEvent('zy_session_rename_started', {})
                  } else {
                    if (lowerInput === 'v' && key.ctrl && focusedLog) {
                      setPreviewLog(focusedLog)
                      setViewMode('preview')
                      logEvent('zy_session_preview_opened', {
                        messageCount: focusedLog.messageCount,
                      })
                    } else {
                      if (
                        focusedLog &&
                        keyIsNotCtrlOrMeta &&
                        input.length > 0 &&
                        !/^\s+$/.test(input)
                      ) {
                        setViewMode('search')
                        setSearchQuery(input)
                        logEvent('zy_session_search_toggled', {
                          enabled: true,
                        })
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    {
      isActive: true,
    },
  )
  const filterIndicators = []
  if (branchFilterEnabled && currentBranch) {
    filterIndicators.push(currentBranch)
  }
  if (hasMultipleWorktrees && !showAllWorktrees) {
    filterIndicators.push(tSync('logSelector.currentWorktree'))
  }
  const showAdditionalFilterLine = filterIndicators.length > 0 && viewMode !== 'search'
  const headerLines = 8 + (showAdditionalFilterLine ? 1 : 0) + tagTabsLines
  const visibleCount = Math.max(1, Math.floor((maxHeight - headerLines - 2) / 3))
  React.useEffect(() => {
    if (!onLoadMore) {
      return
    }
    const buffer = visibleCount * 2
    if (focusedIndex + buffer >= displayedLogs.length) {
      onLoadMore(visibleCount * 3)
    }
  }, [focusedIndex, visibleCount, displayedLogs.length, onLoadMore])
  if (logs.length === 0) {
    return null
  }
  if (viewMode === 'preview' && previewLog && isResumeWithRenameEnabled) {
    return (
      <SessionPreview
        log={previewLog}
        onExit={() => {
          setViewMode('list')
          setPreviewLog(null)
        }}
        onSelect={onSelect}
      />
    )
  }
  const boxElement = Boolean(searchQuery.trim()) &&
    onAgenticSearch &&
    false &&
    agenticSearchState.status !== 'searching' &&
    agenticSearchState.status !== 'results' &&
    agenticSearchState.status !== 'error' && (
      <Box flexShrink={0} flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Text color={isAgenticSearchOptionFocused ? 'suggestion' : undefined}>
            {isAgenticSearchOptionFocused ? fig.pointer : ' '}
          </Text>
          <Text
            color={isAgenticSearchOptionFocused ? 'suggestion' : undefined}
            bold={isAgenticSearchOptionFocused}
          >
            {tSync('logSelector.searchDeeply')} →
          </Text>
        </Box>
        <Box height={1} />
      </Box>
    )
  return (
    <Box flexDirection="column" height={maxHeight - 1}>
      {
        <Box flexShrink={0}>
          <Divider color="suggestion" width={columns} />
        </Box>
      }
      {
        <Box flexShrink={0}>
          <Text> </Text>
        </Box>
      }
      {hasTags ? (
        <TagTabs
          tabs={tagTabs}
          selectedIndex={effectiveTagIndex}
          availableWidth={columns}
          showAllProjects={showAllProjects}
        />
      ) : (
        <Box flexShrink={0}>
          <Text bold={true} color="suggestion">
            {tSync('logSelector.resumeSession')}
            {viewMode === 'list' && displayedLogs.length > visibleCount && (
              <Text dimColor={true}>
                {' '}
                （{focusedIndex} / {displayedLogs.length}）
              </Text>
            )}
          </Text>
        </Box>
      )}
      {
        <SearchBox
          query={searchQuery}
          isFocused={viewMode === 'search'}
          isTerminalFocused={isTerminalFocused}
          cursorOffset={searchCursorOffset}
        />
      }
      {filterIndicators.length > 0 && viewMode !== 'search' && (
        <Box flexShrink={0} paddingLeft={2}>
          <Text dimColor={true}>
            <Byline>{filterIndicators}</Byline>
          </Text>
        </Box>
      )}
      {
        <Box flexShrink={0}>
          <Text> </Text>
        </Box>
      }
      {agenticSearchState.status === 'searching' && (
        <Box paddingLeft={1} flexShrink={0}>
          <Spinner />
          <Text> {tSync('logSelector.searching')}</Text>
        </Box>
      )}
      {agenticSearchState.status === 'results' && agenticSearchState.results.length > 0 && (
        <Box paddingLeft={1} marginBottom={1} flexShrink={0}>
          <Text dimColor={true} italic={true}>
            {tSync('logSelector.results')}
          </Text>
        </Box>
      )}
      {agenticSearchState.status === 'results' &&
        agenticSearchState.results.length === 0 &&
        filteredLogs.length === 0 && (
          <Box paddingLeft={1} marginBottom={1} flexShrink={0}>
            <Text dimColor={true} italic={true}>
              {tSync('logSelector.noResults')}
            </Text>
          </Box>
        )}
      {agenticSearchState.status === 'error' && filteredLogs.length === 0 && (
        <Box paddingLeft={1} marginBottom={1} flexShrink={0}>
          <Text dimColor={true} italic={true}>
            {tSync('logSelector.noResults')}
          </Text>
        </Box>
      )}
      {boxElement}
      {agenticSearchState.status === 'searching' ? null : viewMode === 'rename' && focusedLog ? (
        <Box paddingLeft={2} flexDirection="column">
          <Text bold={true}>{tSync('logSelector.renameSession')}:</Text>
          <Box paddingTop={1}>
            <TextInput
              value={renameValue}
              onChange={setRenameValue}
              onSubmit={handleRenameSubmit}
              placeholder={getLogDisplayTitle(focusedLog, 'Enter new session name')}
              columns={columns}
              cursorOffset={renameCursorOffset}
              onChangeCursorOffset={setRenameCursorOffset}
              showCursor={true}
            />
          </Box>
        </Box>
      ) : isResumeWithRenameEnabled ? (
        <TreeSelect
          nodes={treeNodes}
          onSelect={(node_0) => {
            onSelect(node_0.value.log)
          }}
          onFocus={handleTreeSelectFocus}
          onCancel={onCancel}
          focusNodeId={focusedNode?.id}
          visibleOptionCount={visibleCount}
          layout="expanded"
          isDisabled={viewMode === 'search' || isAgenticSearchOptionFocused}
          hideIndexes={false}
          isNodeExpanded={(nodeId) => {
            if (viewMode === 'search' || branchFilterEnabled) {
              return true
            }
            const sessionId_2 =
              typeof nodeId === 'string' && nodeId.startsWith('group:') ? nodeId.substring(6) : null
            return sessionId_2 ? expandedGroupSessionIds.has(sessionId_2) : false
          }}
          onExpand={(nodeId_0) => {
            const sessionId_3 =
              typeof nodeId_0 === 'string' && nodeId_0.startsWith('group:')
                ? nodeId_0.substring(6)
                : null
            if (sessionId_3) {
              setExpandedGroupSessionIds((prev_0) => new Set(prev_0).add(sessionId_3))
              logEvent('zy_session_group_expanded', {})
            }
          }}
          onCollapse={(nodeId_1) => {
            const sessionId_4 =
              typeof nodeId_1 === 'string' && nodeId_1.startsWith('group:')
                ? nodeId_1.substring(6)
                : null
            if (sessionId_4) {
              setExpandedGroupSessionIds((prev_1) => {
                const newSet = new Set(prev_1)
                newSet.delete(sessionId_4)
                return newSet
              })
            }
          }}
          onUpFromFirstItem={enterSearchMode}
        />
      ) : (
        <Select
          options={flatOptions}
          onChange={(value_0: string) => {
            const itemIndex = parseInt(value_0, 10)
            const log_13 = displayedLogs[itemIndex]
            if (log_13) {
              onSelect(log_13)
            }
          }}
          visibleOptionCount={visibleCount}
          onCancel={onCancel}
          onFocus={handleFlatOptionsSelectFocus}
          defaultFocusValue={focusedNode?.id.toString()}
          layout="expanded"
          isDisabled={viewMode === 'search' || isAgenticSearchOptionFocused}
          onUpFromFirstItem={enterSearchMode}
        />
      )}
      {
        <Box paddingLeft={2}>
          {exitState.pending ? (
            <Text dimColor={true}>
              {tSync('logSelector.pressAgainToExit', {
                key: exitState.keyName ?? '',
              })}
            </Text>
          ) : viewMode === 'rename' ? (
            <Text dimColor={true}>
              <Byline>
                <KeyboardShortcutHint shortcut="Enter" action="logSelector:save" />
                <ConfigurableShortcutHint
                  action="confirm:no"
                  context="Confirmation"
                  fallback="Esc"
                  description={tSync('logSelector.cancel')}
                />
              </Byline>
            </Text>
          ) : agenticSearchState.status === 'searching' ? (
            <Text dimColor={true}>
              <Byline>
                <Text>{tSync('logSelector.search')}...</Text>
                <ConfigurableShortcutHint
                  action="confirm:no"
                  context="Confirmation"
                  fallback="Esc"
                  description={tSync('logSelector.cancel')}
                />
              </Byline>
            </Text>
          ) : isAgenticSearchOptionFocused ? (
            <Text dimColor={true}>
              <Byline>
                <KeyboardShortcutHint shortcut="Enter" action="logSelector:search" />
                <KeyboardShortcutHint shortcut={'\u2193'} action="logSelector:skip" />
                <ConfigurableShortcutHint
                  action="confirm:no"
                  context="Confirmation"
                  fallback="Esc"
                  description={tSync('logSelector.cancel')}
                />
              </Byline>
            </Text>
          ) : viewMode === 'search' ? (
            <Text dimColor={true}>
              <Byline>
                <Text>
                  {isSearching && false
                    ? tSync('logSelector.searching')
                    : tSync('logSelector.typeToSearch')}
                </Text>
                <KeyboardShortcutHint shortcut="Enter" action="select" />
                <ConfigurableShortcutHint
                  action="confirm:no"
                  context="Confirmation"
                  fallback="Esc"
                  description={tSync('logSelector.clear')}
                />
              </Byline>
            </Text>
          ) : (
            <Text dimColor={true}>
              <Byline>
                {onToggleAllProjects && (
                  <KeyboardShortcutHint
                    shortcut="Ctrl+A"
                    action={
                      showAllProjects ? 'logSelector:showCurrentDir' : 'logSelector:showAllProjects'
                    }
                  />
                )}
                {currentBranch && (
                  <KeyboardShortcutHint shortcut="Ctrl+B" action="logSelector:toggleBranch" />
                )}
                {hasMultipleWorktrees && (
                  <KeyboardShortcutHint
                    shortcut="Ctrl+W"
                    action={
                      showAllWorktrees
                        ? 'logSelector:showCurrentWorktree'
                        : 'logSelector:showAllWorktrees'
                    }
                  />
                )}
                <KeyboardShortcutHint shortcut="Ctrl+V" action="logSelector:preview" />
                <KeyboardShortcutHint shortcut="Ctrl+R" action="logSelector:rename" />
                <Text>{tSync('logSelector.typeToSearch')}</Text>
                <ConfigurableShortcutHint
                  action="confirm:no"
                  context="Confirmation"
                  fallback="Esc"
                  description={tSync('logSelector.cancel')}
                />
                {getExpandCollapseHint() && <Text>{getExpandCollapseHint()}</Text>}
              </Byline>
            </Text>
          )}
        </Box>
      }
    </Box>
  )
}

/**
 * Extracts searchable text content from a message.
 * Handles both string content and structured content blocks.
 */

function extractSearchableText(message: SerializedMessage): string {
  // Only extract from user and assistant messages that have content
  if (message.type !== 'user' && message.type !== 'assistant') {
    return ''
  }
  const content = 'message' in message ? message.message?.content : undefined
  if (!content) {
    return ''
  }

  // Handle string content (simple messages)
  if (typeof content === 'string') {
    return content
  }

  // Handle array of content blocks
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') {
          return block
        }
        if ('text' in block && typeof block.text === 'string') {
          return block.text
        }
        return ''
        // we don't return thinking blocks and tool names here;
        // they're not useful for search, as they can add noise to the fuzzy matching
      })
      .filter(Boolean)
      .join(' ')
  }
  return ''
}

/**
 * Builds searchable text for a log including messages, titles, summaries, and metadata.
 * Crops long transcripts to first/last N messages for performance.
 */
function buildSearchableText(log: LogOption): string {
  const searchableMessages =
    log.messages.length <= DEEP_SEARCH_MAX_MESSAGES
      ? log.messages
      : [
          ...log.messages.slice(0, DEEP_SEARCH_CROP_SIZE),
          ...log.messages.slice(-DEEP_SEARCH_CROP_SIZE),
        ]
  const messageText = searchableMessages.map(extractSearchableText).filter(Boolean).join(' ')
  const metadata = [
    log.customTitle,
    log.summary,
    log.firstPrompt,
    log.gitBranch,
    log.tag,
    log.prNumber ? `PR #${log.prNumber}` : undefined,
    log.prRepository,
  ]
    .filter(Boolean)
    .join(' ')
  const fullText = `${metadata} ${messageText}`.trim()
  return fullText.length > DEEP_SEARCH_MAX_TEXT_LENGTH
    ? fullText.slice(0, DEEP_SEARCH_MAX_TEXT_LENGTH)
    : fullText
}
function groupLogsBySessionId(filteredLogs: LogOption[]): Map<string, LogOption[]> {
  const groups = new Map<string, LogOption[]>()
  for (const log of filteredLogs) {
    const sessionId = getSessionIdFromLog(log)
    if (sessionId) {
      const existing = groups.get(sessionId)
      if (existing) {
        existing.push(log)
      } else {
        groups.set(sessionId, [log])
      }
    }
  }

  // Sort logs within each group by modified date (newest first)
  groups.forEach((logs) =>
    logs.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime()),
  )
  return groups
}

/**
 * 计算需要消歧的标题集合:不同会话(sessionId)组若展示标题完全相同,
 * 这些标题会被列入,调用方据此在标题后附加 sessionId 短码加以区分。
 * 每组以最新一条日志(groupLogs[0])的展示标题为准,与列表实际渲染一致。
 */
export function computeDuplicateGroupTitles(sessionGroups: Map<string, LogOption[]>): Set<string> {
  const counts = new Map<string, number>()
  for (const groupLogs of sessionGroups.values()) {
    const firstLog = groupLogs[0]
    if (!firstLog) {
      continue
    }
    const title = getLogDisplayTitle(firstLog)
    counts.set(title, (counts.get(title) ?? 0) + 1)
  }
  const result = new Set<string>()
  for (const [title, count] of counts) {
    if (count > 1) {
      result.add(title)
    }
  }
  return result
}

/**
 * Get unique tags from a list of logs, sorted alphabetically
 */
function getUniqueTags(logs: LogOption[]): string[] {
  const tags = new Set<string>()
  for (const log of logs) {
    if (log.tag) {
      tags.add(log.tag)
    }
  }
  return Array.from(tags).sort((a, b) => a.localeCompare(b))
}
