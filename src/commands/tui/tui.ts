import { tSync } from '../../i18n/index.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import type { LocalCommandCall } from '../types.js'
import { isBgSession } from '../../services/session/concurrentSessions.js'
import { getGlobalConfig, saveGlobalConfig } from '../../services/config/config.js'
import { isEnvDefinedFalsy, isEnvTruthy } from '../../utils/envUtils.js'
import { resolveFullscreenEnabled, setFullscreenRuntimeOverride } from '../../services/terminal/fullscreen.js'

type TuiMode = 'fullscreen' | 'default'

function getModeFromEnabled(enabled: boolean): TuiMode {
  return enabled ? 'fullscreen' : 'default'
}

function getEnvOverrideNotice(targetMode: TuiMode): string | null {
  const envValue = process.env.ZY_CODE_NO_FLICKER
  if (envValue === undefined) {
    return null
  }
  const envMode: TuiMode | null = isEnvTruthy(envValue)
    ? 'fullscreen'
    : isEnvDefinedFalsy(envValue)
      ? 'default'
      : null
  if (envMode === null || envMode === targetMode) {
    return null
  }
  return tSync('commands.tuiEnvOverrideNotice', { env: 'ZY_CODE_NO_FLICKER' })
}

export const call: LocalCommandCall = async (_args) => {
  const args = _args?.trim().toLowerCase()

  // 无参数：显示当前状态
  if (!args) {
    const resolution = resolveFullscreenEnabled()
    const current = getModeFromEnabled(resolution.enabled)
    const pref = getGlobalConfig().tui
    const prefText = pref ? ` (${tSync('commands.tuiSettingsPrefix')}: ${pref})` : ''
    return {
      type: 'text',
      value: `${tSync('commands.tuiCurrent')}: ${current}${prefText}\n${tSync(
        'commands.tuiReason',
      )}: ${resolution.reason}`,
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

  const currentResolution = resolveFullscreenEnabled()
  const currentMode = getModeFromEnabled(currentResolution.enabled)
  const savedMode = getGlobalConfig().tui
  if (targetMode === currentMode && savedMode === targetMode) {
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
  setFullscreenRuntimeOverride(targetMode)

  logEvent('zy_tui_command', {
    from: currentMode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    to: targetMode as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })

  const envOverrideNotice = getEnvOverrideNotice(targetMode)
  return {
    type: 'text',
    value: [
      tSync('commands.tuiSaved', { mode: targetMode }),
      tSync('commands.tuiApplied'),
      envOverrideNotice,
    ]
      .filter(Boolean)
      .join('\n'),
  }
}
