// REPL loading / spinner / streaming 全簇合并。
//
// 合并原 5 个 hook：
// - useReplLoading：queryGuard 订阅 + isLoading 派生 + timing refs
// - useReplSpinnerOverride：spinnerMessage / Color / ShimmerColor + onCompactProgress
// - useReplSpinnerTip：bash tools 累积 + tip 选择
// - useReplStreamingText：流式文本 + showStreamingText 派生
// - useStreamingThinking：thinking bubble + 30s auto-hide
//
// 关键收益：把 REPL.tsx 的 resetLoadingState 内化。
// REPL 通过 onResetAdditional 注入自身剩余的 reset 操作
//（responseLengthRef / setStreamingToolUses / endInteractionSpan /
// clearSpeculativeChecks / setUserInputOnProcessing）。

import type React from 'react'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { tSync } from '../../i18n/index.js'
import { hasCursorUpViewportYankBug } from '../../ink/terminal.js'
import {
  advanceStagePercent,
  buildCompactProgressMessage,
  COMPACT_STAGE_PCT,
} from '../../services/compact/compactProgress.js'
import { getTipToShowOnSpinner, recordShownTip } from '../../components/tips/tipScheduler.js'
import { useAppState, useSetAppState } from '../../state/AppState.js'
import type { ReplStoreInstance } from '../../state/replStore.js'
import type { CompactProgressEvent } from '../../tool.js'
import type { Message as MessageType } from '../../types/message.js'
import type { StreamingThinking } from '../../services/messages/index.js'
import type { QueryGuard } from '../../utils/queryGuard.js'
import { extractBashToolsFromMessages } from '../../utils/queryHelpers.js'
import type { Theme, ThemeName } from '../../utils/theme.js'

// ── 公共类型 ──────────────────────────────────────────────

export type ReplLoadingState = {
  // loading
  isQueryActive: boolean
  isLoading: boolean
  isExternalLoading: boolean
  setIsExternalLoading: (value: boolean) => void
  resetTimingRefs: () => void
  loadingStartTimeRef: React.RefObject<number>
  totalPausedMsRef: React.RefObject<number>
  pauseStartTimeRef: React.RefObject<number | null>
  // spinner override
  spinnerMessage: string | null
  spinnerColor: keyof Theme | null
  spinnerShimmerColor: keyof Theme | null
  onCompactProgress: (event: CompactProgressEvent) => void
  // spinner tip
  ingestBashToolsFromMessages: (messages: MessageType[]) => void
  clearBashToolsTracking: () => void
  resetTipPickedThisTurn: () => void
  // streaming text
  streamingText: string | null
  setStreamingText: React.Dispatch<React.SetStateAction<string | null>>
  onStreamingText: (f: (current: string | null) => string | null) => void
  visibleStreamingText: string | null
  showStreamingText: boolean
  // streaming thinking
  streamingThinking: StreamingThinking | null
  setStreamingThinking: React.Dispatch<React.SetStateAction<StreamingThinking | null>>
  // 核心收益：resetLoadingState 内化
  resetLoadingState: () => void
}

export type UseReplLoadingStateParams = {
  queryGuard: QueryGuard
  initialExternalLoading: boolean
  theme: ThemeName
  replStore: ReplStoreInstance
  /** REPL 侧剩余 reset 操作（responseLengthRef / setStreamingToolUses / ...） */
  onResetAdditional: () => void
}

// ── 主 hook ──────────────────────────────────────────────

const AUTO_HIDE_AFTER_MS = 30000

export function useReplLoadingState({
  queryGuard,
  initialExternalLoading,
  theme,
  replStore,
  onResetAdditional,
}: UseReplLoadingStateParams): ReplLoadingState {
  // ── loading ──
  const isQueryActive = useSyncExternalStore(queryGuard.subscribe, queryGuard.getSnapshot)
  const [isExternalLoading, setIsExternalLoadingRaw] = useState(initialExternalLoading)
  const isLoading = isQueryActive || isExternalLoading

  const loadingStartTimeRef = useRef<number>(0)
  const totalPausedMsRef = useRef(0)
  const pauseStartTimeRef = useRef<number | null>(null)

  const resetTimingRefs = useCallback(() => {
    loadingStartTimeRef.current = Date.now()
    totalPausedMsRef.current = 0
    pauseStartTimeRef.current = null
  }, [])

  const wasQueryActiveRef = useRef(false)
  if (isQueryActive && !wasQueryActiveRef.current) {
    resetTimingRefs()
  }
  wasQueryActiveRef.current = isQueryActive

  const setIsExternalLoading = useCallback(
    (value: boolean) => {
      setIsExternalLoadingRaw(value)
      if (value) {
        resetTimingRefs()
      }
    },
    [resetTimingRefs],
  )

  // ── spinner override ──
  const [spinnerMessage, setSpinnerMessage] = useState<string | null>(null)
  const [spinnerColor, setSpinnerColor] = useState<keyof Theme | null>(null)
  const [spinnerShimmerColor, setSpinnerShimmerColor] = useState<keyof Theme | null>(null)

  // compact 真实阶段进度：业务层 emit stage+pct；≥90% 后 compact_end 直接卸条
  const compactPctRef = useRef(0)
  const compactStageRef = useRef<string | undefined>(undefined)
  /** 是否处于 compact 会话（hooks / start / progress / end） */
  const isCompactActiveRef = useRef(false)

  const applyCompactStagePct = useCallback((stage: string | undefined, pct: number) => {
    const next = advanceStagePercent(compactPctRef.current, pct)
    compactPctRef.current = next
    if (stage) {
      compactStageRef.current = stage
    }
    setSpinnerMessage(
      buildCompactProgressMessage({
        stage: compactStageRef.current,
        pct: next,
      }),
    )
  }, [])

  const resetSpinnerOverride = useCallback(() => {
    isCompactActiveRef.current = false
    compactPctRef.current = 0
    compactStageRef.current = undefined
    setSpinnerMessage(null)
    setSpinnerColor(null)
    setSpinnerShimmerColor(null)
  }, [])

  const onCompactProgress = useCallback(
    (event: CompactProgressEvent) => {
      switch (event.type) {
        case 'hooks_start': {
          setSpinnerColor('ZyBlue_FOR_SYSTEM_SPINNER')
          setSpinnerShimmerColor('ZyBlueShimmer_FOR_SYSTEM_SPINNER')
          isCompactActiveRef.current = true
          // 按 hook 类型映射真实阶段 pct（与业务 emit 对齐，hooks_start 先到也能显示）
          if (event.hookType === 'pre_compact') {
            applyCompactStagePct('pre_hooks', COMPACT_STAGE_PCT.pre_hooks)
          } else if (event.hookType === 'session_start') {
            applyCompactStagePct('session_start', COMPACT_STAGE_PCT.session_start)
          } else {
            applyCompactStagePct('post_hooks', COMPACT_STAGE_PCT.post_hooks)
          }
          break
        }
        case 'compact_start':
          setSpinnerColor('ZyBlue_FOR_SYSTEM_SPINNER')
          setSpinnerShimmerColor('ZyBlueShimmer_FOR_SYSTEM_SPINNER')
          isCompactActiveRef.current = true
          applyCompactStagePct('start', COMPACT_STAGE_PCT.start)
          break
        case 'compact_progress':
          isCompactActiveRef.current = true
          if (event.hintText) {
            setSpinnerMessage(buildCompactProgressMessage(event))
            if (event.pct !== undefined) {
              compactPctRef.current = advanceStagePercent(compactPctRef.current, event.pct)
            }
          } else {
            applyCompactStagePct(event.stage, event.pct)
          }
          break
        case 'compact_end':
          // 超过 90%（post_hooks=94%）后直接卸 spinner，不在 100% 满条停留
          resetSpinnerOverride()
          break
      }
    },
    [applyCompactStagePct, resetSpinnerOverride],
  )

  // ── spinner tip ──
  const setAppState = useSetAppState()
  const bashToolsRef = useRef(new Set<string>())
  const bashToolsProcessedIdxRef = useRef(0)
  const tipPickedThisTurnRef = useRef(false)

  const pickNewSpinnerTip = useCallback(() => {
    if (tipPickedThisTurnRef.current) {
      return
    }
    tipPickedThisTurnRef.current = true
    const msgs = replStore.getState().messages
    const newMessages = msgs.slice(bashToolsProcessedIdxRef.current)
    for (const tool of extractBashToolsFromMessages(newMessages)) {
      bashToolsRef.current.add(tool)
    }
    bashToolsProcessedIdxRef.current = msgs.length
    void getTipToShowOnSpinner({
      theme,
      readFileState: replStore.mutable.readFileState,
      bashTools: bashToolsRef.current,
    }).then(async (tip) => {
      if (tip) {
        const content = await tip.content({ theme })
        setAppState((prev) => ({ ...prev, spinnerTip: content }))
        recordShownTip(tip)
      } else {
        setAppState((prev) => {
          if (prev.spinnerTip === undefined) {
            return prev
          }
          return { ...prev, spinnerTip: undefined }
        })
      }
    })
  }, [setAppState, theme, replStore])

  const ingestBashToolsFromMessages = useCallback((messages: MessageType[]) => {
    for (const tool of extractBashToolsFromMessages(messages)) {
      bashToolsRef.current.add(tool)
    }
  }, [])

  const clearBashToolsTracking = useCallback(() => {
    bashToolsRef.current.clear()
    bashToolsProcessedIdxRef.current = 0
  }, [])

  const resetTipPickedThisTurn = useCallback(() => {
    tipPickedThisTurnRef.current = false
  }, [])

  // ── streaming text ──
  const [streamingText, setStreamingText] = useState<string | null>(null)
  const reducedMotion = useAppState((s) => s.settings.prefersReducedMotion) ?? false
  const showStreamingText = !reducedMotion && !hasCursorUpViewportYankBug()

  const onStreamingText = useCallback(
    (f: (current: string | null) => string | null) => {
      if (!showStreamingText) {
        return
      }
      setStreamingText(f)
    },
    [showStreamingText],
  )

  const visibleStreamingText =
    streamingText && showStreamingText
      ? streamingText.substring(0, streamingText.lastIndexOf('\n') + 1) || null
      : null

  // ── streaming thinking ──
  const [streamingThinking, setStreamingThinking] = useState<StreamingThinking | null>(null)

  useEffect(() => {
    if (streamingThinking && !streamingThinking.isStreaming && streamingThinking.streamingEndedAt) {
      const elapsed = Date.now() - streamingThinking.streamingEndedAt
      const remaining = AUTO_HIDE_AFTER_MS - elapsed
      if (remaining > 0) {
        const timer = setTimeout(setStreamingThinking, remaining, null)
        return () => clearTimeout(timer)
      }
      setStreamingThinking(null)
    }
  }, [streamingThinking])

  // ── resetLoadingState（关键收益：内化 5 个子 reset + 委托 REPL 剩余）──
  const resetLoadingState = useCallback(() => {
    setIsExternalLoading(false)
    setStreamingText(null)
    setStreamingThinking(null)
    resetSpinnerOverride()
    pickNewSpinnerTip()
    onResetAdditional()
  }, [setIsExternalLoading, resetSpinnerOverride, pickNewSpinnerTip, onResetAdditional])

  return {
    isQueryActive,
    isLoading,
    isExternalLoading,
    setIsExternalLoading,
    resetTimingRefs,
    loadingStartTimeRef,
    totalPausedMsRef,
    pauseStartTimeRef,
    spinnerMessage,
    spinnerColor,
    spinnerShimmerColor,
    onCompactProgress,
    ingestBashToolsFromMessages,
    clearBashToolsTracking,
    resetTipPickedThisTurn,
    streamingText,
    setStreamingText,
    onStreamingText,
    visibleStreamingText,
    showStreamingText,
    streamingThinking,
    setStreamingThinking,
    resetLoadingState,
  }
}
