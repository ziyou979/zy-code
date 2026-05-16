import type { LocalJSXCommandCall } from '../../types/command.js'
import { getInitialSettings, updateSettingsForSource } from '../../utils/settings/settings.js'

export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const settings = getInitialSettings()
  const currentConfig = settings.builtInStatusBar ?? {}
  const currentlyEnabled = currentConfig.enabled !== false

  const argsLower = args.trim().toLowerCase()
  const moduleNames = [
    'directory',
    'model',
    'context',
    'tokens',
    'cost',
    'agents',
    'memory',
  ] as const
  type ModuleName = (typeof moduleNames)[number]

  // /statusline reset → 恢复默认（全部启用）
  if (argsLower === 'reset') {
    updateSettingsForSource('userSettings', {
      builtInStatusBar: { enabled: true, modules: undefined },
    })
    context.setAppState((prev) => ({
      ...prev,
      settings: {
        ...prev.settings,
        builtInStatusBar: { enabled: true },
      },
    }))
    onDone('状态栏已重置为默认配置', { display: 'system' })
    return null
  }

  // /statusline <模块名> → 切换单个模块
  if ((moduleNames as readonly string[]).includes(argsLower)) {
    const modules = { ...(currentConfig.modules ?? {}) }
    const currentModuleValue = modules[argsLower as ModuleName] !== false // 默认 true
    modules[argsLower as ModuleName] = !currentModuleValue

    updateSettingsForSource('userSettings', {
      builtInStatusBar: { modules },
    })
    context.setAppState((prev) => ({
      ...prev,
      settings: {
        ...prev.settings,
        builtInStatusBar: {
          ...prev.settings.builtInStatusBar,
          modules,
        },
      },
    }))

    const statusText = !currentModuleValue ? '开' : '关'
    onDone(`状态栏模块 "${argsLower}" 已${statusText}`, { display: 'system' })
    return null
  }

  // /statusline on|off → 显式设置开关
  if (argsLower === 'on' || argsLower === 'off') {
    const enable = argsLower === 'on'
    updateSettingsForSource('userSettings', {
      builtInStatusBar: { enabled: enable },
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
    onDone(enable ? 'statusLine.enabled' : 'statusLine.disabled', { display: 'system' })
    return null
  }

  // /statusline（无参数）→ 切换开关 + 显示当前模块配置
  const newEnabled = !currentlyEnabled

  updateSettingsForSource('userSettings', {
    builtInStatusBar: { enabled: newEnabled },
  })
  context.setAppState((prev) => ({
    ...prev,
    settings: {
      ...prev.settings,
      builtInStatusBar: {
        ...prev.settings.builtInStatusBar,
        enabled: newEnabled,
      },
    },
  }))

  if (newEnabled) {
    // 显示当前模块状态
    const moduleLines = moduleNames.map((m) => {
      const visible = currentConfig.modules?.[m] !== false
      return `  ${visible ? '☑' : '☐'} ${m}`
    })
    onDone(
      `状态栏已启用\n当前模块:\n${moduleLines.join('\n')}\n\n/statusline <模块名> 可切换单个模块`,
      { display: 'system' },
    )
  } else {
    onDone('statusLine.disabled', { display: 'system' })
  }
  return null
}
