import { getIsInteractive } from '../../bootstrap/runtime/runtimeContext.js'
import { ManagedSettingsSecurityDialog } from '../ManagedSettingsSecurityDialog/ManagedSettingsSecurityDialog.js'
import { render } from '../../ink/index.js'
import { KeybindingSetup } from '../../keybindings/KeybindingProviderSetup.js'
import { logEvent } from '../../services/analytics/index.js'
import {
  needsManagedSettingsSecurityCheck,
  type SecurityCheckResult,
} from '../../services/remote-managed-settings/securityPolicy.js'
import { AppStateProvider } from '../../state/AppState.js'
import { getBaseRenderOptions } from '../../utils/renderOptions.js'
import type { SettingsJson } from '../../services/settings/types.js'

/**
 * - approved: 用户明确同意（交互对话框）
 * - rejected: 用户拒绝
 * - no_check_needed: 无危险变更，可安全落盘
 * - deferred_non_interactive: 非交互路径存在危险变更 — 会话内可暂用，**禁止**落盘为「已同意」
 *   （对齐 CC 2.1.207：claude -p / SDK 不得永久记录未展示过的 consent）
 */
export type { SecurityCheckResult } from '../../services/remote-managed-settings/securityPolicy.js'

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
  if (!newSettings) {
    return 'no_check_needed'
  }
  // 如果新设置没有危险设置，无需检查
  if (!needsManagedSettingsSecurityCheck(cachedSettings, newSettings)) {
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
