/**
 * 用于推荐 LSP 插件的 hook
 *
 * 检测文件编辑，并在满足以下条件时推荐 LSP 插件：
 * - 文件扩展名与某个 LSP 插件匹配
 * - 系统中已安装对应的 LSP binary
 * - 插件尚未安装
 * - 用户未关闭推荐
 *
 * 每个会话只显示一次推荐。
 */

import { extname, join } from 'node:path'
import * as React from 'react'
import {
  hasShownLspRecommendationThisSession,
  setLspRecommendationShownThisSession,
} from 'src/bootstrap/runtime/runtimeContext.js'
import { useNotifications } from '../context/notifications.js'
import { useAppState } from '../state/AppState.js'
import { saveGlobalConfig } from '../services/config/config.js'
import { logForDebugging } from '../services/infra/debug.js'
import { logError } from '../services/infra/log.js'
import {
  addToNeverSuggest,
  getMatchingLspPlugins,
  incrementIgnoredCount,
} from '../services/plugins/lspRecommendation.js'
import { cacheAndRegisterPlugin } from '../services/plugins/pluginInstallationHelpers.js'
import { getSettingsForSource, updateSettingsForSource } from '../services/settings/settings.js'
import {
  installPluginAndNotify,
  usePluginRecommendationBase,
} from './usePluginRecommendationBase.js'

// 区分超时和用户主动关闭的阈值（毫秒）
// 菜单会在 30 秒时自动关闭，因此超过 28 秒基本可视为超时
const TIMEOUT_THRESHOLD_MS = 28_000
export type LspRecommendationState = {
  pluginId: string
  pluginName: string
  pluginDescription?: string
  fileExtension: string
  shownAt: number // Timestamp for timeout detection
} | null
type UseLspPluginRecommendationResult = {
  recommendation: LspRecommendationState
  handleResponse: (response: 'yes' | 'no' | 'never' | 'disable') => void
}
export function useLspPluginRecommendation(): UseLspPluginRecommendationResult {
  const trackedFiles = useAppState((s) => s.fileHistory.trackedFiles)
  const { addNotification } = useNotifications()
  const checkedFilesRef = React.useRef(new Set())
  const { recommendation, clearRecommendation, tryResolve } =
    usePluginRecommendationBase<NonNullable<LspRecommendationState>>()
  React.useEffect(() => {
    tryResolve(async () => {
      if (hasShownLspRecommendationThisSession()) {
        return null
      }
      const newFiles = []
      for (const file of trackedFiles) {
        if (!checkedFilesRef.current.has(file)) {
          checkedFilesRef.current.add(file)
          newFiles.push(file)
        }
      }
      for (const filePath of newFiles) {
        try {
          const matches = await getMatchingLspPlugins(filePath)
          const match = matches[0]
          if (match) {
            logForDebugging(
              `[useLspPluginRecommendation] Found match: ${match.pluginName} for ${filePath}`,
            )
            setLspRecommendationShownThisSession(true)
            return {
              pluginId: match.pluginId,
              pluginName: match.pluginName,
              pluginDescription: match.description,
              fileExtension: extname(filePath),
              shownAt: Date.now(),
            }
          }
        } catch (error) {
          logError(error)
        }
      }
      return null
    })
  }, [trackedFiles, tryResolve])
  const handleResponse = (response: 'yes' | 'no' | 'never' | 'disable') => {
    if (!recommendation) {
      return
    }
    const { pluginId, pluginName, shownAt } = recommendation
    logForDebugging(`[useLspPluginRecommendation] User response: ${response} for ${pluginName}`)
    switch (response) {
      case 'yes': {
        installPluginAndNotify(
          pluginId,
          pluginName,
          'lsp-plugin',
          addNotification,
          async (pluginData) => {
            logForDebugging(`[useLspPluginRecommendation] Installing plugin: ${pluginId}`)
            const localSourcePath =
              typeof pluginData.entry.source === 'string'
                ? join(pluginData.marketplaceInstallLocation, pluginData.entry.source)
                : undefined
            await cacheAndRegisterPlugin(
              pluginId,
              pluginData.entry,
              'user',
              undefined,
              localSourcePath,
            )
            const settings = getSettingsForSource('userSettings')
            updateSettingsForSource('userSettings', {
              enabledPlugins: {
                ...settings?.enabledPlugins,
                [pluginId]: true,
              },
            })
            logForDebugging(`[useLspPluginRecommendation] Plugin installed: ${pluginId}`)
          },
        )
        break
      }
      case 'no': {
        const elapsed = Date.now() - shownAt
        if (elapsed >= TIMEOUT_THRESHOLD_MS) {
          logForDebugging(
            `[useLspPluginRecommendation] Timeout detected (${elapsed}ms), incrementing ignored count`,
          )
          incrementIgnoredCount()
        }
        break
      }
      case 'never': {
        addToNeverSuggest(pluginId)
        break
      }
      case 'disable': {
        saveGlobalConfig((current) => {
          if (current.lspRecommendationDisabled) {
            return current
          }
          return {
            ...current,
            lspRecommendationDisabled: true,
          }
        })
      }
    }
    clearRecommendation()
  }
  return {
    recommendation,
    handleResponse,
  }
}
