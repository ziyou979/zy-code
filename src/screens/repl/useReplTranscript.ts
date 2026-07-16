// Transcript 视图全簇合并。
//
// 合并原 4 个 hook：
// - useFrozenTranscript：enter/exit callback + 切片派生
// - useReplSearch：/ + n/N 键绑定 + highlight overlay
// - useTranscriptEditor：[ dump 模式 + v 外部编辑器 + q 退出
// - useViewedAgentBootstrap：agent sidechain JSONL 合并
//
// 核心收益：dumpMode / editorStatus 从 REPL.tsx 移入本模块闭包，
// 消除了 search ↔ editor 的循环声明顺序问题。

import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { JumpHandle } from '../../components/VirtualMessageList.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { useSearchHighlight } from '../../ink/hooks/use-search-highlight.js'
import { useInput } from '../../ink/index.js'
import { useAppState, useSetAppState } from '../../state/AppState.js'
import type { Tools } from '../../tools/Tool.js'
import { isLocalAgentTask } from '../../tasks/local-agent-task/LocalAgentTask.js'
import { asAgentId } from '../../types/ids.js'
import type { Message } from '../../types/message.js'
import { openFileInExternalEditor } from '../../terminal-ui/editor.js'
import { renderMessagesToPlainText } from '../../components/Runtime/ExportRenderer.js'
import { StreamingToolUse } from '../../services/messages/./streaming.js'
import { getAgentTranscript } from '../../services/sessionStorage.js'

// ── 公共类型 ──────────────────────────────────────────────

export type UseReplTranscriptParams = {
  messages: Message[]
  streamingToolUses: StreamingToolUse[]
  deferredMessages: Message[]
  screen: 'prompt' | 'transcript'
  virtualScrollActive: boolean
  tools: Tools
  setShowAllInTranscript: (next: boolean) => void
}

export type ReplTranscriptApi = {
  // frozen
  handleEnterTranscript: () => void
  handleExitTranscript: () => void
  transcriptMessages: Message[]
  transcriptStreamingToolUses: StreamingToolUse[]
  // search
  jumpRef: React.RefObject<JumpHandle | null>
  searchOpen: boolean
  setSearchOpen: React.Dispatch<React.SetStateAction<boolean>>
  searchQuery: string
  setSearchQuery: React.Dispatch<React.SetStateAction<string>>
  searchCount: number
  setSearchCount: React.Dispatch<React.SetStateAction<number>>
  searchCurrent: number
  setSearchCurrent: React.Dispatch<React.SetStateAction<number>>
  onSearchMatchesChange: (count: number, current: number) => void
  setHighlight: (query: string) => void
  scanElement: ReturnType<typeof useSearchHighlight>['scanElement']
  setPositions: ReturnType<typeof useSearchHighlight>['setPositions']
  // editor（原先留在 REPL.tsx 的 dumpMode / editorStatus 现在内化）
  dumpMode: boolean
  editorStatus: string
}

// ── 主 hook ──────────────────────────────────────────────

export function useReplTranscript({
  messages,
  streamingToolUses,
  deferredMessages,
  screen,
  virtualScrollActive,
  tools,
  setShowAllInTranscript,
}: UseReplTranscriptParams): ReplTranscriptApi {
  const inTranscript = screen === 'transcript' && virtualScrollActive

  // ── viewed-agent bootstrap（纯副作用）──
  const viewingAgentTaskId = useAppState((s) => s.viewingAgentTaskId)
  const tasks = useAppState((s) => s.tasks)
  const setAppState = useSetAppState()
  const viewedLocalAgent = viewingAgentTaskId ? tasks[viewingAgentTaskId] : undefined
  const needsBootstrap =
    isLocalAgentTask(viewedLocalAgent) && viewedLocalAgent.retain && !viewedLocalAgent.diskLoaded

  useEffect(() => {
    if (!viewingAgentTaskId || !needsBootstrap) {
      return
    }
    const taskId = viewingAgentTaskId
    const agentIdFallback =
      isLocalAgentTask(viewedLocalAgent) && viewedLocalAgent.agentId !== taskId
        ? viewedLocalAgent.agentId
        : undefined
    void (async () => {
      // 先按 taskId 加载；空白时再试 agentId（冷恢复/worktree 路径不一致时 CC 2.1.207）
      let result = await getAgentTranscript(asAgentId(taskId))
      if ((!result || result.messages.length === 0) && agentIdFallback) {
        result = await getAgentTranscript(asAgentId(agentIdFallback))
      }
      setAppState((prev) => {
        const t = prev.tasks[taskId]
        if (!isLocalAgentTask(t) || t.diskLoaded || !t.retain) {
          return prev
        }
        const live = t.messages ?? []
        const liveUuids = new Set(live.map((m) => m.uuid))
        const diskOnly = result ? result.messages.filter((m) => !liveUuids.has(m.uuid)) : []
        return {
          ...prev,
          tasks: {
            ...prev.tasks,
            [taskId]: { ...t, messages: [...diskOnly, ...live], diskLoaded: true },
          },
        }
      })
    })()
  }, [viewingAgentTaskId, needsBootstrap, setAppState, viewedLocalAgent])

  // ── frozen transcript ──
  const [frozenTranscriptState, setFrozenTranscriptState] = useState<{
    messagesLength: number
    streamingToolUsesLength: number
  } | null>(null)

  const handleEnterTranscript = useCallback(() => {
    setFrozenTranscriptState({
      messagesLength: messages.length,
      streamingToolUsesLength: streamingToolUses.length,
    })
  }, [messages.length, streamingToolUses.length])

  const handleExitTranscript = useCallback(() => {
    setFrozenTranscriptState(null)
  }, [])

  const transcriptMessages = frozenTranscriptState
    ? deferredMessages.slice(0, frozenTranscriptState.messagesLength)
    : deferredMessages
  const transcriptStreamingToolUses = frozenTranscriptState
    ? streamingToolUses.slice(0, frozenTranscriptState.streamingToolUsesLength)
    : streamingToolUses

  // ── dumpMode / editorStatus（原先 REPL.tsx 持有的 state，现在内化）──
  const [dumpMode, setDumpMode] = useState(false)
  const [editorStatus, setEditorStatus] = useState('')

  // ── search ──
  const jumpRef = useRef<JumpHandle | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchCount, setSearchCount] = useState(0)
  const [searchCurrent, setSearchCurrent] = useState(0)
  const onSearchMatchesChange = useCallback((count: number, current: number) => {
    setSearchCount(count)
    setSearchCurrent(current)
  }, [])

  useInput(
    (input, key, event) => {
      if (key.ctrl || key.meta) {
        return
      }
      if (input === '/') {
        jumpRef.current?.setAnchor()
        setSearchOpen(true)
        event.stopImmediatePropagation()
        return
      }
      const c = input[0]
      if ((c === 'n' || c === 'N') && input === c.repeat(input.length) && searchCount > 0) {
        const fn = c === 'n' ? jumpRef.current?.nextMatch : jumpRef.current?.prevMatch
        if (fn) {
          for (let i = 0; i < input.length; i++) {
            fn()
          }
        }
        event.stopImmediatePropagation()
      }
    },
    { isActive: screen === 'transcript' && virtualScrollActive && !searchOpen && !dumpMode },
  )

  const { setQuery: setHighlight, scanElement, setPositions } = useSearchHighlight()

  const transcriptCols = useTerminalSize().columns
  const prevColsRef = React.useRef(transcriptCols)
  React.useEffect(() => {
    if (prevColsRef.current !== transcriptCols) {
      prevColsRef.current = transcriptCols
      if (searchQuery || searchOpen) {
        setSearchOpen(false)
        setSearchQuery('')
        setSearchCount(0)
        setSearchCurrent(0)
        jumpRef.current?.disarmSearch()
        setHighlight('')
      }
    }
  }, [transcriptCols, searchQuery, searchOpen, setHighlight])

  useEffect(() => {
    if (!inTranscript) {
      setSearchQuery('')
      setSearchCount(0)
      setSearchCurrent(0)
      setSearchOpen(false)
    }
  }, [inTranscript])

  useEffect(() => {
    setHighlight(inTranscript ? searchQuery : '')
    if (!inTranscript) {
      setPositions(null)
    }
  }, [inTranscript, searchQuery, setHighlight, setPositions])

  // ── editor（[ dump / v external / q exit）──
  const editorGenRef = useRef(0)
  const editorTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const editorRenderingRef = useRef(false)

  useInput(
    (input, key, event) => {
      if (key.ctrl || key.meta) {
        return
      }
      if (input === 'q') {
        handleExitTranscript()
        event.stopImmediatePropagation()
        return
      }
      if (input === '[' && !dumpMode) {
        setDumpMode(true)
        setShowAllInTranscript(true)
        event.stopImmediatePropagation()
      } else if (input === 'v') {
        event.stopImmediatePropagation()
        if (editorRenderingRef.current) {
          return
        }
        editorRenderingRef.current = true
        const gen = editorGenRef.current
        const setStatus = (s: string): void => {
          if (gen !== editorGenRef.current) {
            return
          }
          clearTimeout(editorTimerRef.current)
          setEditorStatus(s)
        }
        setStatus(`rendering ${deferredMessages.length} messages…`)
        void (async () => {
          try {
            // eslint-disable-next-line custom-rules/prefer-use-terminal-size -- one-shot at keypress time
            const w = Math.max(80, (process.stdout.columns ?? 80) - 6)
            const raw = await renderMessagesToPlainText([...deferredMessages], tools, w)
            const text = raw.replace(/[ \t]+$/gm, '')
            const path = join(tmpdir(), `cc-transcript-${Date.now()}.txt`)
            await writeFile(path, text)
            const opened = openFileInExternalEditor(path)
            setStatus(opened ? `opening ${path}` : `wrote ${path} · no $VISUAL/$EDITOR set`)
          } catch (e) {
            setStatus(`render failed: ${e instanceof Error ? e.message : String(e)}`)
          }
          editorRenderingRef.current = false
          if (gen !== editorGenRef.current) {
            return
          }
          editorTimerRef.current = setTimeout((s) => s(''), 4000, setEditorStatus)
        })()
      }
    },
    { isActive: screen === 'transcript' && virtualScrollActive && !searchOpen },
  )

  useEffect(() => {
    if (!inTranscript) {
      editorGenRef.current++
      clearTimeout(editorTimerRef.current)
      setDumpMode(false)
      setEditorStatus('')
    }
  }, [inTranscript])

  return {
    handleEnterTranscript,
    handleExitTranscript,
    transcriptMessages,
    transcriptStreamingToolUses,
    jumpRef,
    searchOpen,
    setSearchOpen,
    searchQuery,
    setSearchQuery,
    searchCount,
    setSearchCount,
    searchCurrent,
    setSearchCurrent,
    onSearchMatchesChange,
    setHighlight,
    scanElement,
    setPositions,
    dumpMode,
    editorStatus,
  }
}
