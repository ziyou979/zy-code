import { setMainLoopModelOverride } from 'src/bootstrap/runtime/runtimeContext.js'
import { getAPIProvider } from '../services/model/providers.js'
import { clearApiKeyHelperCache } from '../services/auth/auth.js'
import { getGlobalConfig, saveGlobalConfig } from '../services/config/config.js'
import { isInternalBuild } from '../services/infra/envUtils.js'
import { toError } from '../utils/errors.js'
import { logError } from '../services/infra/log.js'
import { applyConfigEnvironmentVariables } from '../services/environment/managedEnv.js'
import {
  permissionModeFromString,
  toExternalPermissionMode,
} from '../services/permissions/permissionMode.js'
import {
  notifyPermissionModeChanged,
  notifySessionMetadataChanged,
  type SessionExternalMetadata,
} from '../services/session-state/sessionState.js'
import { getInitialSettings, updateSettingsForSource } from '../services/settings/settings.js'
import { savePermissionMode } from '../services/session-storage/sessionMetadata.js'
import type { AppState } from './AppStateStore.js'

// 与下方 push 相反，worker 重启时恢复。
export function externalMetadataToAppState(
  metadata: SessionExternalMetadata,
): (prev: AppState) => AppState {
  return (prev) => ({
    ...prev,
    ...(typeof metadata.permission_mode === 'string'
      ? {
          toolPermissionContext: {
            ...prev.toolPermissionContext,
            mode: permissionModeFromString(metadata.permission_mode),
          },
        }
      : {}),
    ...(typeof metadata.is_ultraplan_mode === 'boolean'
      ? { isUltraplanMode: metadata.is_ultraplan_mode }
      : {}),
  })
}

export function onChangeAppState({
  newState,
  oldState,
}: {
  newState: AppState
  oldState: AppState
}) {
  // toolPermissionContext.mode——CCR/SDK 模式同步的唯一入口。
  //
  // 此逻辑加入前，8 条以上的修改路径中只有 2 条会把模式变化转发给 CCR：
  // print.ts 的专用 setAppState wrapper（仅 headless/SDK 模式）和
  // set_permission_mode handler 中的手动通知。其他路径——Shift+Tab 循环、
  // ExitPlanModePermissionRequest 对话框选项、/plan、rewind、REPL bridge 的
  // onSetPermissionMode——只修改 AppState 而不通知 CCR，导致
  // external_metadata.permission_mode 过期，Web UI 与 CLI 实际模式不同步。
  //
  // 在这里监听差异后，任何改变模式的 setAppState 调用都会通知 CCR
  //（notifySessionMetadataChanged → ccrClient.reportMetadata）和 SDK 状态流
  //（notifyPermissionModeChanged → print.ts 中注册的处理器），无需修改上述分散调用点。
  const prevMode = oldState.toolPermissionContext.mode
  const newMode = newState.toolPermissionContext.mode
  if (prevMode !== newMode) {
    // CCR external_metadata 不得收到仅内部使用的模式名（bubble、未门控 auto）。
    // 先外部化；若外部模式未改变则跳过 CCR 通知，例如 default→bubble→default
    // 在 CCR 看来都是 default，只是噪声。SDK channel（notifyPermissionModeChanged）
    // 传递原始模式，由 print.ts 的 listener 自行过滤。
    const prevExternal = toExternalPermissionMode(prevMode)
    const newExternal = toExternalPermissionMode(newMode)
    if (prevExternal !== newExternal) {
      // Ultraplan 只适用于首轮 plan。初始 control_request 会原子设置 mode 与
      // isUltraplanMode，因此用 flag 的变化门控。按 RFC 7396 使用 null 删除 key。
      const isUltraplan =
        newExternal === 'plan' && newState.isUltraplanMode && !oldState.isUltraplanMode
          ? true
          : null
      notifySessionMetadataChanged({
        permission_mode: newExternal,
        is_ultraplan_mode: isUltraplan,
      })
    }
    notifyPermissionModeChanged(newMode)

    // 持久化到 session sidecar，确保 /resume 后保留当前模式
    savePermissionMode(newMode)
  }

  // mainLoopModel：持久化到 settings。
  // 如果值是 tier 名（advanced/standard/compact），写入 mainLoopModel 字段
  // 否则写入 model 字段并清除 mainLoopModel（覆盖模式）
  if (newState.mainLoopModel !== oldState.mainLoopModel) {
    const TIER_NAMES = ['advanced', 'standard', 'compact'] as const
    const settings = getInitialSettings()
    const currentProvider = getAPIProvider()
    const shouldPersistProviderScoped =
      settings.providers !== undefined && settings.providers[currentProvider] !== undefined
    const updateModelSettings = (modelUpdate: {
      model?: string
      mainLoopModel?: 'advanced' | 'standard' | 'compact'
    }) => {
      if (!shouldPersistProviderScoped) {
        updateSettingsForSource('userSettings', modelUpdate)
        return
      }
      updateSettingsForSource('userSettings', {
        providers: {
          ...settings.providers,
          [currentProvider]: {
            ...settings.providers?.[currentProvider],
            ...modelUpdate,
          },
        },
      })
    }
    if (newState.mainLoopModel === null) {
      // 恢复默认：清除覆盖字段
      updateModelSettings({
        model: undefined,
        mainLoopModel: undefined,
      })
      setMainLoopModelOverride(null)
    } else if (TIER_NAMES.includes(newState.mainLoopModel as (typeof TIER_NAMES)[number])) {
      // tier 名 → 写入 mainLoopModel，清除 model 覆盖
      updateModelSettings({
        model: undefined,
        mainLoopModel: newState.mainLoopModel as 'advanced' | 'standard' | 'compact',
      })
      setMainLoopModelOverride(newState.mainLoopModel)
    } else {
      // 具体模型名 → 写入 model 覆盖字段，清除 mainLoopModel
      updateModelSettings({
        model: newState.mainLoopModel,
        mainLoopModel: undefined,
      })
      setMainLoopModelOverride(newState.mainLoopModel)
    }
  }

  // expandedView：为向后兼容，持久化为 showExpandedTodos + showSpinnerTree。
  if (newState.expandedView !== oldState.expandedView) {
    const showExpandedTodos = newState.expandedView === 'tasks'
    const showSpinnerTree = newState.expandedView === 'teammates'
    if (
      getGlobalConfig().showExpandedTodos !== showExpandedTodos ||
      getGlobalConfig().showSpinnerTree !== showSpinnerTree
    ) {
      saveGlobalConfig((current) => ({
        ...current,
        showExpandedTodos,
        showSpinnerTree,
      }))
    }
  }

  // verbose
  if (newState.verbose !== oldState.verbose && getGlobalConfig().verbose !== newState.verbose) {
    const verbose = newState.verbose
    saveGlobalConfig((current) => ({
      ...current,
      verbose,
    }))
  }

  // tungstenPanelVisible（仅供 ant 使用的 tmux 面板粘性开关）。
  if (isInternalBuild()) {
    if (
      newState.tungstenPanelVisible !== oldState.tungstenPanelVisible &&
      newState.tungstenPanelVisible !== undefined &&
      getGlobalConfig().tungstenPanelVisible !== newState.tungstenPanelVisible
    ) {
      const tungstenPanelVisible = newState.tungstenPanelVisible
      saveGlobalConfig((current) => ({ ...current, tungstenPanelVisible }))
    }
  }

  // settings：发生变化时清除认证相关缓存，确保 apiKeyHelper 与 AWS/GCP 凭据修改立即生效。
  if (newState.settings !== oldState.settings) {
    try {
      clearApiKeyHelperCache()

      // settings.env 变化时重新应用环境变量。此操作只增不减：加入新变量，
      // 可能覆盖已有变量，但不会删除任何变量。
      if (newState.settings.env !== oldState.settings.env) {
        applyConfigEnvironmentVariables()
      }
    } catch (error) {
      logError(toError(error))
    }
  }
}
