import {
  DEFAULT_MODULES,
  MODULE_IDS,
  type ModuleConfig,
  type ModuleId,
  mergeWithDefaults,
} from '../../components/statusbar/statusbarModuleDefaults.js'
import { tSync } from '../../i18n/index.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import {
  getEffectiveStatuslineConfig,
  saveStatuslineConfig,
} from '../../utils/settings/statuslineConfig.js'
import { createStatuslineDialog } from './StatuslineConfigDialog.js'

/**
 * 写入 statusline.json 并刷新 settings 缓存，使 useSettings() 能获取最新值
 */
function writeStatuslineAndRefresh(config: {
  enabled: boolean
  modules?: ModuleConfig[]
}): void {
  saveStatuslineConfig(config)
  resetSettingsCache()
}

export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const settings = getInitialSettings()
  const effectiveConfig = getEffectiveStatuslineConfig(settings.builtInStatusBar)
  const currentlyEnabled = effectiveConfig.enabled !== false

  const argsLower = args.trim().toLowerCase()

  // ─── /statusline reset → 恢复默认 ─────────────────────────────────────
  if (argsLower === 'reset') {
    const defaults = DEFAULT_MODULES.map((m) => ({ ...m }))
    writeStatuslineAndRefresh({ enabled: true, modules: defaults })
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
    writeStatuslineAndRefresh({ ...effectiveConfig, enabled: enable })
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
    const merged = mergeWithDefaults(effectiveConfig.modules)
    const next: ModuleConfig[] = merged.map((m) =>
      m.id === id ? { ...m, visible: !m.visible } : m
    )
    writeStatuslineAndRefresh({ ...effectiveConfig, enabled: true, modules: next })
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
    writeStatuslineAndRefresh({ ...effectiveConfig, enabled: true })
    context.setAppState((prev) => ({
      ...prev,
      settings: {
        ...prev.settings,
        builtInStatusBar: { ...prev.settings.builtInStatusBar, enabled: true },
      },
    }))
  }

  return createStatuslineDialog(onDone, (next) => {
    writeStatuslineAndRefresh({ ...effectiveConfig, enabled: true, modules: next })
    context.setAppState((prev) => ({
      ...prev,
      settings: {
        ...prev.settings,
        builtInStatusBar: { enabled: true, modules: next },
      },
    }))
  })
}
