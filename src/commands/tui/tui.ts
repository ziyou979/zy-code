import { tSync } from '../../i18n/index.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import type { LocalCommandCall } from '../../types/command.js'
import { isBgSession } from '../../utils/concurrentSessions.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js'

type TuiMode = 'fullscreen' | 'default'

export const call: LocalCommandCall = async (_args) => {
  const args = _args?.trim().toLowerCase()

  // 无参数：显示当前状态
  if (!args) {
    const current = isFullscreenEnvEnabled() ? 'fullscreen' : 'default'
    const pref = getGlobalConfig().tui
    const prefText = pref ? ` (${tSync('commands.tuiSettingsPrefix')}: ${pref})` : ''
    return {
      type: 'text',
      value: `${tSync('commands.tuiCurrent')}: ${current}${prefText}`,
    }
  }

  if (args !== 'fullscreen' && args !== 'default') {
    return {
      type: 'text',
      value: tSync('commands.tuiUsage'),
    }
  }

  const targetMode: TuiMode = args

  // 后台会话拒绝切换
  if (isBgSession()) {
    return {
      type: 'text',
      value: tSync('commands.tuiBgRefuse'),
    }
  }

  const currentMode: TuiMode = isFullscreenEnvEnabled() ? 'fullscreen' : 'default'
  if (targetMode === currentMode) {
    return {
      type: 'text',
      value: `${tSync('commands.tuiAlready')} ${targetMode}`,
    }
  }

  // 写入持久化偏好
  saveGlobalConfig((current) => ({
    ...current,
    tui: targetMode,
  }))

  logEvent('zy_tui_command', {
    from: currentMode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    to: targetMode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })

  return {
    type: 'text',
    value: `${tSync('commands.tuiSaved', { mode: targetMode })}\n${tSync('commands.tuiRestart')}`,
  }
}
