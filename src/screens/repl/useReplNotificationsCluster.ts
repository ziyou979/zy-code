// REPL 通知 / 横幅 / 系统提示 / 挫败感检测 / away summary 合并模块。
//
// 合并原 5 个 hook：
// - useReplNotifications：14 个 fire-and-forget 通知 hook + lsp/hint 推荐
// - useReplCallouts：effort / remote / desktop upsell 横幅状态
// - useReplSystemHints：swarm 延迟 turn-duration + auto-mode 警告 + worktree 提示
// - useReplFrustration：内部构建挫败感检测条件 require
// - useReplAwaySummary：feature-flagged away summary（火忘，无返回值）
//
// 一次调用，组装所有返回值。

import { feature } from 'bun:bundle'
import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import { getAutoModeDescription } from '../../components/AutoModeOptInDialog.js'
import { shouldShowDesktopUpsellStartup } from '../../components/DesktopUpsell/DesktopUpsellStartup.js'
import { shouldShowFullscreenUpsell } from '../../components/FullscreenUpsell/FullscreenUpsellDialog.js'
import { useAutoModeUnavailableNotification } from '../../hooks/notifs/useAutoModeUnavailableNotification.js'
import { useCanSwitchToExistingSubscription } from '../../hooks/notifs/useCanSwitchToExistingSubscription.js'
import { useInstallMessages } from '../../hooks/notifs/useInstallMessages.js'
import { useLspInitializationNotification } from '../../hooks/notifs/useLspInitializationNotification.js'
import { useNpmDeprecationNotification } from '../../hooks/notifs/useNpmDeprecationNotification.js'
import { usePluginAutoupdateNotification } from '../../hooks/notifs/usePluginAutoupdateNotification.js'
import { usePluginInstallationStatus } from '../../hooks/notifs/usePluginInstallationStatus.js'
import { useRateLimitWarningNotification } from '../../hooks/notifs/useRateLimitWarningNotification.js'
import { useSettingsErrors } from '../../hooks/notifs/useSettingsErrors.js'
import { useTeammateLifecycleNotification } from '../../hooks/notifs/useTeammateShutdownNotification.js'
// 通知子 hook
import { useChromeExtensionNotification } from '../../hooks/useChromeExtensionNotification.js'
import { useLspPluginRecommendation } from '../../hooks/useLspPluginRecommendation.js'
import { useOfficialMarketplaceNotification } from '../../hooks/useOfficialMarketplaceNotification.js'
import { useZyCodeHintRecommendation } from '../../hooks/useZyCodeHintRecommendation.js'
import type { ModelName } from '../../services/model/model.js'
import { useAppState } from '../../state/AppState.js'
import type { Message as MessageType } from '../../types/message.js'
import { count } from '../../utils/array.js'
import { getGlobalConfig, saveGlobalConfig } from '../../services/config/config.js'
import { isInternalBuild } from '../../services/infra/envUtils.js'
import {
  createSystemMessage,
  createTurnDurationMessage,
} from '../../services/messages/./constructors.js'
import { isLoggableMessage } from '../../services/sessionStorage.js'
import { getSettingsForSource } from '../../services/settings/settings.js'
import { getCurrentWorktreeSession } from '../../services/worktree/worktree.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const useAntOrgWarningNotification: typeof import('../../hooks/notifs/useAntOrgWarningNotification.js').useAntOrgWarningNotification =
  isInternalBuild()
    ? require('../../hooks/notifs/useAntOrgWarningNotification.js').useAntOrgWarningNotification
    : () => {}

const useFrustrationDetectionLazy: typeof import('../../components/FeedbackSurvey/useFrustrationDetection.js').useFrustrationDetection =
  isInternalBuild()
    ? require('../../components/FeedbackSurvey/useFrustrationDetection.js').useFrustrationDetection
    : () => ({ state: 'closed' as const, handleTranscriptSelect: () => {} })

const useAwaySummaryLazy: typeof import('../../hooks/useAwaySummary.js').useAwaySummary | null =
  feature('AWAY_SUMMARY') ? require('../../hooks/useAwaySummary.js').useAwaySummary : null
/* eslint-enable @typescript-eslint/no-require-imports */

// ── 公共类型 ──────────────────────────────────────────────

export type ReplFrustrationDetection = {
  state: 'closed' | 'open' | 'thanks' | 'transcript_prompt' | 'submitting' | 'submitted'
  handleTranscriptSelect: () => void
}

export type ReplNotificationsCluster = {
  // 通知 / 推荐
  lspRecommendation: ReturnType<typeof useLspPluginRecommendation>['recommendation']
  handleLspResponse: ReturnType<typeof useLspPluginRecommendation>['handleResponse']
  hintRecommendation: ReturnType<typeof useZyCodeHintRecommendation>['recommendation']
  handleHintResponse: ReturnType<typeof useZyCodeHintRecommendation>['handleResponse']
  // 横幅
  showEffortCallout: boolean
  setShowEffortCallout: (next: boolean) => void
  showRemoteCallout: boolean
  showDesktopUpsellStartup: boolean
  setShowDesktopUpsellStartup: (next: boolean) => void
  showFullscreenUpsell: boolean
  setShowFullscreenUpsell: (next: boolean) => void
  // 系统提示 + swarm（hasRunningTeammates 由 REPL 侧计算，此处不重复暴露）
  swarmStartTimeRef: React.RefObject<number | null>
  swarmBudgetInfoRef: React.RefObject<{ tokens: number; limit: number; nudges: number } | undefined>
  // 挫败感
  frustrationDetection: ReplFrustrationDetection
}

export type UseReplNotificationsClusterParams = {
  mainLoopModel: ModelName
  messages: readonly MessageType[]
  setMessages: (action: React.SetStateAction<MessageType[]>) => void
  isLoading: boolean
  hasActivePrompt: boolean
  isSurveyOpen: boolean
  /** REPL 侧预先计算（showSpinner 派生需要早于本 hook 调用） */
  hasRunningTeammates: boolean
}

// ── 主 hook ──────────────────────────────────────────────

export function useReplNotificationsCluster({
  mainLoopModel,
  messages,
  setMessages,
  isLoading,
  hasActivePrompt,
  isSurveyOpen,
  hasRunningTeammates,
}: UseReplNotificationsClusterParams): ReplNotificationsCluster {
  // ── 14 fire-and-forget notifications ──
  useCanSwitchToExistingSubscription()
  useAutoModeUnavailableNotification()
  usePluginInstallationStatus()
  usePluginAutoupdateNotification()
  useSettingsErrors()
  useRateLimitWarningNotification(mainLoopModel)
  useNpmDeprecationNotification()
  useAntOrgWarningNotification()
  useInstallMessages()
  useChromeExtensionNotification()
  useOfficialMarketplaceNotification()
  useLspInitializationNotification()
  useTeammateLifecycleNotification()
  const { recommendation: lspRecommendation, handleResponse: handleLspResponse } =
    useLspPluginRecommendation()
  const { recommendation: hintRecommendation, handleResponse: handleHintResponse } =
    useZyCodeHintRecommendation()

  // ── callouts ──
  const [showEffortCallout, setShowEffortCallout] = useState(() => {
    const settings = getSettingsForSource('userSettings')
    return !settings?.effortLevel
  })
  const showRemoteCallout = useAppState((s) => s.showRemoteCallout)
  const [showDesktopUpsellStartup, setShowDesktopUpsellStartup] = useState(() =>
    shouldShowDesktopUpsellStartup(),
  )
  const [showFullscreenUpsell, setShowFullscreenUpsell] = useState(() =>
    shouldShowFullscreenUpsell(),
  )

  // ── system hints: swarm turn-duration ──
  const toolPermissionMode = useAppState((s) => s.toolPermissionContext.mode)
  const swarmStartTimeRef = useRef<number | null>(null)
  const swarmBudgetInfoRef = useRef<{ tokens: number; limit: number; nudges: number } | undefined>(
    undefined,
  )

  useEffect(() => {
    if (!hasRunningTeammates && swarmStartTimeRef.current !== null) {
      const totalMs = Date.now() - swarmStartTimeRef.current
      const deferredBudget = swarmBudgetInfoRef.current
      swarmStartTimeRef.current = null
      swarmBudgetInfoRef.current = undefined
      setMessages((prev) => [
        ...prev,
        createTurnDurationMessage(totalMs, deferredBudget, count(prev, isLoggableMessage)),
      ])
    }
  }, [hasRunningTeammates, setMessages])

  // ── system hints: auto-mode 安全警告 ──
  const safeYoloMessageShownRef = useRef(false)
  useEffect(() => {
    if (toolPermissionMode !== 'auto') {
      safeYoloMessageShownRef.current = false
      return
    }
    if (safeYoloMessageShownRef.current) {
      return
    }
    const config = getGlobalConfig()
    const cnt = config.autoPermissionsNotificationCount ?? 0
    if (cnt >= 3) {
      return
    }
    const timer = setTimeout(
      (ref: { current: boolean }, setMsgs: typeof setMessages) => {
        ref.current = true
        saveGlobalConfig((prev) => {
          const prevCount = prev.autoPermissionsNotificationCount ?? 0
          if (prevCount >= 3) {
            return prev
          }
          return { ...prev, autoPermissionsNotificationCount: prevCount + 1 }
        })
        setMsgs((prev) => [...prev, createSystemMessage(getAutoModeDescription(), 'warn')])
      },
      800,
      safeYoloMessageShownRef,
      setMessages,
    )
    return () => clearTimeout(timer)
  }, [toolPermissionMode, setMessages])

  // ── system hints: worktree sparse-checkout 提示 ──
  const worktreeTipShownRef = useRef(false)
  useEffect(() => {
    if (worktreeTipShownRef.current) {
      return
    }
    const wt = getCurrentWorktreeSession()
    if (!wt?.creationDurationMs || wt.usedSparsePaths) {
      return
    }
    if (wt.creationDurationMs < 15_000) {
      return
    }
    worktreeTipShownRef.current = true
    const secs = Math.round(wt.creationDurationMs / 1000)
    setMessages((prev) => [
      ...prev,
      createSystemMessage(
        `Worktree creation took ${secs}s. For large repos, set \`worktree.sparsePaths\` in .zy/settings.json to check out only the directories you need — e.g. \`{"worktree": {"sparsePaths": ["src", "packages/foo"]}}\`.`,
        'info',
      ),
    ])
  }, [setMessages])

  // ── frustration detection ──
  const frustrationDetection = useFrustrationDetectionLazy(
    messages,
    isLoading,
    hasActivePrompt,
    isSurveyOpen,
  )

  // ── away summary（火忘，无返回值）──
  if (feature('AWAY_SUMMARY')) {
    // biome-ignore lint/correctness/useHookAtTopLevel: feature() 是构建时常量
    useAwaySummaryLazy!(messages, setMessages, isLoading)
  }

  return {
    lspRecommendation,
    handleLspResponse,
    hintRecommendation,
    handleHintResponse,
    showEffortCallout,
    setShowEffortCallout,
    showRemoteCallout,
    showDesktopUpsellStartup,
    setShowDesktopUpsellStartup,
    showFullscreenUpsell,
    setShowFullscreenUpsell,
    swarmStartTimeRef,
    swarmBudgetInfoRef,
    frustrationDetection,
  }
}
