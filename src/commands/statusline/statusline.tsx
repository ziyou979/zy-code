import {
  DEFAULT_MODULES,
  mergeWithDefaults,
  MODULE_IDS,
  type ModuleConfig,
  type ModuleId,
} from '../../components/statusbar/statusbarModuleDefaults.js'
import { tSync } from '../../i18n/index.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { getInitialSettings, updateSettingsForSource } from '../../utils/settings/settings.js'
import { createStatuslineDialog } from './StatuslineConfigDialog.js'

export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const settings = getInitialSettings()
  const currentConfig = settings.builtInStatusBar ?? {}
  const currentlyEnabled = currentConfig.enabled !== false

  const argsLower = args.trim().toLowerCase()

  // ─── /statusline reset → 恢复默认 ─────────────────────────────────────
  if (argsLower === 'reset') {
    const defaults = DEFAULT_MODULES.map((m) => ({ ...m }))
    updateSettingsForSource('userSettings', {
      builtInStatusBar: { enabled: true, modules: defaults },
    })
    context.setAppState((prev) => ({
      ...prev,
      settings: {
        ...prev.settings,
        builtInStatusBar: { enabled: true, modules: defaults },
      },
    }))
    onDone(tSync('statusline.reset'), { display: 'system' })
    return null
  }

  // ─── /statusline on|off → 显式开关 ────────────────────────────────────
  if (argsLower === 'on' || argsLower === 'off') {
    const enable = argsLower === 'on'
    updateSettingsForSource('userSettings', {
      builtInStatusBar: { ...currentConfig, enabled: enable },
    })
    context.setAppState((prev) => ({
      ...prev,
      settings: {
        ...prev.settings,
        builtInStatusBar: {
          ...prev.settings.builtInStatusBar,
          enabled: enable,
        },
      },
    }))
    onDone(enable ? tSync('statusline.enabled') : tSync('statusline.disabled'), {
      display: 'system',
    })
    return null
  }

  // ─── /statusline <module> → 切换单个模块 ──────────────────────────────
  if ((MODULE_IDS as readonly string[]).includes(argsLower)) {
    const id = argsLower as ModuleId
    const merged = mergeWithDefaults(currentConfig.modules)
    const next: ModuleConfig[] = merged.map((m) =>
      m.id === id ? { ...m, visible: !m.visible } : m,
    )
    updateSettingsForSource('userSettings', {
      builtInStatusBar: { ...currentConfig, modules: next },
    })
    context.setAppState((prev) => ({
      ...prev,
      settings: {
        ...prev.settings,
        builtInStatusBar: {
          ...prev.settings.builtInStatusBar,
          modules: next,
        },
      },
    }))
    const visible = next.find((m) => m.id === id)?.visible
    onDone(tSync(visible ? 'statusline.moduleOn' : 'statusline.moduleOff', { module: id }), {
      display: 'system',
    })
    return null
  }

  // ─── 无参数 → 弹出交互式对话框 ────────────────────────────────────────
  if (!currentlyEnabled) {
    // 未启用时先启用，再打开 dialog
    updateSettingsForSource('userSettings', {
      builtInStatusBar: { ...currentConfig, enabled: true },
    })
    context.setAppState((prev) => ({
      ...prev,
      settings: {
        ...prev.settings,
        builtInStatusBar: { ...prev.settings.builtInStatusBar, enabled: true },
      },
    }))
  }

  return createStatuslineDialog(onDone, (next) => {
    updateSettingsForSource('userSettings', {
      builtInStatusBar: { enabled: true, modules: next },
    })
    context.setAppState((prev) => ({
      ...prev,
      settings: {
        ...prev.settings,
        builtInStatusBar: { enabled: true, modules: next },
      },
    }))
  })
}
