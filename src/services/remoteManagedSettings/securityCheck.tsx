import { getIsInteractive } from '../../bootstrap/state.js'
import { ManagedSettingsSecurityDialog } from '../../components/ManagedSettingsSecurityDialog/ManagedSettingsSecurityDialog.js'
import {
  extractDangerousSettings,
  hasDangerousSettings,
  hasDangerousSettingsChanged,
} from '../../components/ManagedSettingsSecurityDialog/utils.js'
import { render } from '../../ink.js'
import { KeybindingSetup } from '../../keybindings/KeybindingProviderSetup.js'
import { AppStateProvider } from '../../state/AppState.js'
import { gracefulShutdownSync } from '../../utils/gracefulShutdown.js'
import { getBaseRenderOptions } from '../../utils/renderOptions.js'
import type { SettingsJson } from '../../utils/settings/types.js'
import { logEvent } from '../analytics/index.js'
/**
 * - approved: 用户明确同意（交互对话框）
 * - rejected: 用户拒绝
 * - no_check_needed: 无危险变更，可安全落盘
 * - deferred_non_interactive: 非交互路径存在危险变更 — 会话内可暂用，**禁止**落盘为「已同意」
 *   （对齐 CC 2.1.207：claude -p / SDK 不得永久记录未展示过的 consent）
 */
export type SecurityCheckResult =
  | 'approved'
  | 'rejected'
  | 'no_check_needed'
  | 'deferred_non_interactive'

/**
 * 检查新的远程托管设置是否包含需要用户批准的危险设置。
 * 如果危险设置发生更改或新增，会显示阻塞对话框。
 *
 * @param cachedSettings 当前缓存的设置（首次运行时可能为 null）
 * @param newSettings 从 API 获取的新设置
 * @returns 见 SecurityCheckResult
 */
export async function checkManagedSettingsSecurity(
  cachedSettings: SettingsJson | null,
  newSettings: SettingsJson | null,
): Promise<SecurityCheckResult> {
  // 如果新设置没有危险设置，无需检查
  if (!newSettings || !hasDangerousSettings(extractDangerousSettings(newSettings))) {
    return 'no_check_needed'
  }

  // 如果危险设置未发生变化，无需检查
  if (!hasDangerousSettingsChanged(cachedSettings, newSettings)) {
    return 'no_check_needed'
  }

  // 非交互：不弹窗，也不把危险设置永久记为已同意
  if (!getIsInteractive()) {
    logEvent('zy_managed_settings_security_deferred_non_interactive', {})
    return 'deferred_non_interactive'
  }

  // 记录对话框已显示
  logEvent('zy_managed_settings_security_dialog_shown', {})

  // 显示阻塞对话框
  return new Promise<SecurityCheckResult>((resolve) => {
    void (async () => {
      const { unmount } = await render(
        <AppStateProvider>
          <KeybindingSetup>
            <ManagedSettingsSecurityDialog
              settings={newSettings}
              onAccept={() => {
                logEvent('zy_managed_settings_security_dialog_accepted', {})
                unmount()
                void resolve('approved')
              }}
              onReject={() => {
                logEvent('zy_managed_settings_security_dialog_rejected', {})
                unmount()
                void resolve('rejected')
              }}
            />
          </KeybindingSetup>
        </AppStateProvider>,
        getBaseRenderOptions(false),
      )
    })()
  })
}

/**
 * 处理安全检查结果，如果被拒绝则退出
 * 返回 true 表示继续应用（含会话内 deferred），false 表示停止
 */
export function handleSecurityCheckResult(result: SecurityCheckResult): boolean {
  if (result === 'rejected') {
    gracefulShutdownSync(1)
    return false
  }
  return true
}

/** 是否允许把远程托管设置写入磁盘缓存（视为用户已同意危险项） */
export function shouldPersistManagedSettingsAfterSecurityCheck(
  result: SecurityCheckResult,
): boolean {
  // deferred_non_interactive：会话可用，但不得落盘为「已同意」
  return result === 'approved' || result === 'no_check_needed'
}
