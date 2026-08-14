/**
 * 展示由 CLI/SDK 写入 stderr 的 `<zy-code-hint />` 标签所触发的插件安装提示。
 * 详见 docs/zy-code-hints.md。
 *
 * 每个插件最多提示一次，无论用户选择 yes 还是 no 都会记入配置。
 * maybeRecordPluginHint 在写入前已经滤掉已安装、已展示或超过上限的提示，
 * 因此传到此 hook 的提示都值得继续解析。
 */

import * as React from 'react'
import { useNotifications } from '../context/notifications.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
  logEvent,
} from '../services/analytics/index.js'
import { logForDebugging } from '../services/infra/debug.js'
import {
  disableHintRecommendations,
  markHintPluginShown,
  type PluginHintRecommendation,
  resolvePluginHint,
} from '../services/plugins/hintRecommendation.js'
import { installPluginFromMarketplace } from '../services/plugins/pluginInstallationHelpers.js'
import {
  clearPendingHint,
  getPendingHintSnapshot,
  markShownThisSession,
  subscribeToPendingHint,
} from '../services/hints/zyCodeHints.js'
import {
  installPluginAndNotify,
  usePluginRecommendationBase,
} from './usePluginRecommendationBase.js'

type UseZyCodeHintRecommendationResult = {
  recommendation: PluginHintRecommendation | null
  handleResponse: (response: 'yes' | 'no' | 'disable') => void
}
export function useZyCodeHintRecommendation() {
  const pendingHint = React.useSyncExternalStore(subscribeToPendingHint, getPendingHintSnapshot)
  const { addNotification } = useNotifications()
  const { recommendation, clearRecommendation, tryResolve } =
    usePluginRecommendationBase<PluginHintRecommendation>()
  React.useEffect(() => {
    if (!pendingHint) {
      return
    }
    tryResolve(async () => {
      const resolved = await resolvePluginHint(pendingHint)
      if (resolved) {
        logForDebugging(
          `[useZyCodeHintRecommendation] surfacing ${resolved.pluginId} from ${resolved.sourceCommand}`,
        )
        markShownThisSession()
      }
      if (getPendingHintSnapshot() === pendingHint) {
        clearPendingHint()
      }
      return resolved
    })
  }, [pendingHint, tryResolve])
  const handleResponse = (response: 'yes' | 'no' | 'disable') => {
    if (!recommendation) {
      return
    }
    markHintPluginShown(recommendation.pluginId)
    logEvent('zy_plugin_hint_response', {
      _PROTO_plugin_name:
        recommendation.pluginName as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
      _PROTO_marketplace_name:
        recommendation.marketplaceName as AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
      response: response as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    switch (response) {
      case 'yes': {
        const { pluginId, pluginName, marketplaceName } = recommendation
        installPluginAndNotify(
          pluginId,
          pluginName,
          'hint-plugin',
          addNotification,
          async (pluginData) => {
            const result = await installPluginFromMarketplace({
              pluginId,
              entry: pluginData.entry,
              marketplaceName,
              scope: 'user',
              trigger: 'hint',
            })
            if (!result.success) {
              throw new Error((result as { error?: string }).error)
            }
          },
        )
        break
      }
      case 'disable': {
        disableHintRecommendations()
        break
      }
      case 'no':
    }
    clearRecommendation()
  }
  return {
    recommendation,
    handleResponse,
  }
}
