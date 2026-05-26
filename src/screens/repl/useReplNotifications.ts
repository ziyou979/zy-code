// REPL 通知与推荐 hook 集合。
// 从 screens/REPL.tsx:739-763 抽出 14 个 fire-and-forget 通知 hook + 2 个返回推荐的 hook。
// 抽离原则：本 hook 不接 IDE / MCP 这类跨簇 state —— 那部分留在 REPL 主体，等
// 各自 container 抽出时统一收敛。
//
// 入参：mainLoopModel（useRateLimitWarningNotification 的唯一外部依赖）
// 返回：lspRecommendation / handleLspResponse / hintRecommendation / handleHintResponse —
//      用于驱动 REPL 的 focusedInputDialog 与对应 dialog 组件渲染。

import type { ModelName } from '../../services/model/model.js'
import { useChromeExtensionNotification } from '../../hooks/useChromeExtensionNotification.js'
import { useLspPluginRecommendation } from '../../hooks/useLspPluginRecommendation.js'
import { useOfficialMarketplaceNotification } from '../../hooks/useOfficialMarketplaceNotification.js'
import { useZyCodeHintRecommendation } from '../../hooks/useZyCodeHintRecommendation.js'
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
import { isInternalBuild } from '../../utils/envUtils.js'

// Ant 专属组织警告。条件 require 以便从外部构建中消除组织 UUID 列表
// （其中一个 UUID 在 excluded-strings 上）。沿用原 REPL.tsx:185 的延迟形态。
const useAntOrgWarningNotification: typeof import('../../hooks/notifs/useAntOrgWarningNotification.js').useAntOrgWarningNotification =
  isInternalBuild()
    ? require('../../hooks/notifs/useAntOrgWarningNotification.js').useAntOrgWarningNotification
    : () => {}

export type ReplNotifications = {
  lspRecommendation: ReturnType<typeof useLspPluginRecommendation>['recommendation']
  handleLspResponse: ReturnType<typeof useLspPluginRecommendation>['handleResponse']
  hintRecommendation: ReturnType<typeof useZyCodeHintRecommendation>['recommendation']
  handleHintResponse: ReturnType<typeof useZyCodeHintRecommendation>['handleResponse']
}

export function useReplNotifications(mainLoopModel: ModelName): ReplNotifications {
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
  return {
    lspRecommendation,
    handleLspResponse,
    hintRecommendation,
    handleHintResponse,
  }
}
