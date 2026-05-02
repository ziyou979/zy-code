/**
 * Surfaces plugin-install prompts driven by `<zy-code-hint />` tags
 * that CLIs/SDKs emit to stderr. See docs/zy-code-hints.md.
 *
 * Show-once semantics: each plugin is prompted for at most once ever,
 * recorded in config regardless of yes/no. The pre-store gate in
 * maybeRecordPluginHint already dropped installed/shown/capped hints, so
 * anything that reaches this hook is worth resolving.
 */

import * as React from 'react'
import { useNotifications } from '../context/notifications.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED,
  logEvent,
} from '../services/analytics/index.js'
import {
  clearPendingHint,
  getPendingHintSnapshot,
  markShownThisSession,
  subscribeToPendingHint,
} from '../utils/zyCodeHints.js'
import { logForDebugging } from '../utils/debug.js'
import {
  disableHintRecommendations,
  markHintPluginShown,
  type PluginHintRecommendation,
  resolvePluginHint,
} from '../utils/plugins/hintRecommendation.js'
import { installPluginFromMarketplace } from '../utils/plugins/pluginInstallationHelpers.js'
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
  const { recommendation, clearRecommendation, tryResolve } = usePluginRecommendationBase()
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
  const handleResponse = (response) => {
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
              throw new Error((result as any).error)
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
