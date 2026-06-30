import * as React from 'react'
import { tSync } from '../../i18n/index.js'
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { getMainLoopModel } from '../../services/model/model.js'
import { useAppState, useSetAppState } from '../../state/AppState.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import {
  type EffortValue,
  getDisplayedEffortLevel,
  getEffortEnvOverride,
  getEffortValueDescription,
  getModelEffortLevels,
  isEffortLevel,
  toPersistableEffort,
} from '../../utils/effort.js'
import { updateSettingsForSource } from '../../utils/settings/settings.js'

const COMMON_HELP_ARGS = ['help', '-h', '--help']
type EffortCommandResult = {
  message: string
  effortUpdate?: {
    value: EffortValue | undefined
  }
}
function setEffortValue(effortValue: EffortValue): EffortCommandResult {
  const persistable = toPersistableEffort(effortValue)
  if (persistable !== undefined) {
    const result = updateSettingsForSource('userSettings', {
      effortLevel: persistable,
    })
    if (result.error) {
      return {
        message: tSync('effort.command.failedToSet', { error: result.error.message }),
      }
    }
  }
  logEvent('zy_effort_command', {
    effort: effortValue as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })

  // 获取翻译后的 effort 名称
  const valueName = tSync(`effort.${effortValue}` as any) || effortValue

  // Env var wins at resolveAppliedEffort time. Only flag it when it actually
  // conflicts — if env matches what the user just asked for, the outcome is
  // the same, so "Set effort to X" is true and the note is noise.
  const envOverride = getEffortEnvOverride()
  if (envOverride !== undefined && envOverride !== effortValue) {
    const envVar = 'ZY_CODE_EFFORT_LEVEL'
    const envRaw = process.env.ZY_CODE_EFFORT_LEVEL
    if (persistable === undefined) {
      return {
        message: tSync('effort.command.notAppliedEnvOverride', {
          envVar: `${envVar}=${envRaw}`,
          value: valueName,
        }),
        effortUpdate: {
          value: effortValue,
        },
      }
    }
    return {
      message: tSync('effort.command.envOverrideHint', {
        envVar: `${envVar}=${envRaw}`,
        value: valueName,
      }),
      effortUpdate: {
        value: effortValue,
      },
    }
  }
  const description = getEffortValueDescription(effortValue)
  const suffix = persistable !== undefined ? '' : tSync('effort.sessionOnly')
  return {
    message: tSync('effort.command.setSuccess', {
      value: valueName,
      suffix,
      description,
    }),
    effortUpdate: {
      value: effortValue,
    },
  }
}
export function showCurrentEffort(
  appStateEffort: EffortValue | undefined,
  model: string,
): EffortCommandResult {
  const envOverride = getEffortEnvOverride()
  const effectiveValue = envOverride === null ? undefined : (envOverride ?? appStateEffort)
  if (effectiveValue === undefined) {
    const level = getDisplayedEffortLevel(model, appStateEffort)
    const levelName = tSync(`effort.${level}` as any) || level
    return {
      message: tSync('effort.command.currentAuto', { level: levelName }),
    }
  }
  const description = getEffortValueDescription(effectiveValue)
  const valueName = tSync(`effort.${effectiveValue}` as any) || effectiveValue
  return {
    message: tSync('effort.command.current', { value: valueName, description }),
  }
}
function unsetEffortLevel(): EffortCommandResult {
  const result = updateSettingsForSource('userSettings', {
    effortLevel: undefined,
  })
  if (result.error) {
    return {
      message: tSync('effort.command.failedToSet', { error: result.error.message }),
    }
  }
  logEvent('zy_effort_command', {
    effort: 'auto' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
  // env=auto/unset (null) matches what /effort auto asks for, so only warn
  // when env is pinning a specific level that will keep overriding.
  const envOverride = getEffortEnvOverride()
  if (envOverride !== undefined && envOverride !== null) {
    const envRaw = process.env.ZY_CODE_EFFORT_LEVEL
    return {
      message: tSync('effort.command.clearedButEnvOverride', {
        envVar: `ZY_CODE_EFFORT_LEVEL=${envRaw}`,
      }),
      effortUpdate: {
        value: undefined,
      },
    }
  }
  return {
    message: tSync('effort.command.setToAuto'),
    effortUpdate: {
      value: undefined,
    },
  }
}
export function executeEffort(args: string, model?: string): EffortCommandResult {
  const normalized = args.toLowerCase()
  if (normalized === 'auto' || normalized === 'unset') {
    return unsetEffortLevel()
  }
  if (!isEffortLevel(normalized)) {
    // 获取模型支持的选项
    const supportedLevels = model ? getModelEffortLevels(model) : []
    const validOptions = [...supportedLevels, 'auto'].join(', ')
    return {
      message: tSync('effort.command.invalidArgument', { args, validOptions }),
    }
  }
  return setEffortValue(normalized)
}
function ShowCurrentEffort(props: { onDone: LocalJSXCommandOnDone }) {
  const { onDone } = props
  const effortValue = useAppState((s) => s.effortValue)
  const model = useMainLoopModel()
  const { message } = showCurrentEffort(effortValue, model)
  onDone(message)
  return null
}
function ApplyEffortAndClose({
  result,
  onDone,
}: {
  result: EffortCommandResult
  onDone: LocalJSXCommandOnDone
}) {
  const setAppState = useSetAppState()
  const { effortUpdate, message } = result
  React.useEffect(() => {
    if (effortUpdate) {
      setAppState((prev) => ({
        ...prev,
        effortValue: effortUpdate.value,
      }))
    }
    onDone(message)
  }, [setAppState, effortUpdate, message, onDone])
  return null
}
export async function call(
  onDone: LocalJSXCommandOnDone,
  _context: unknown,
  args?: string,
): Promise<React.ReactNode> {
  args = args?.trim() || ''
  if (COMMON_HELP_ARGS.includes(args)) {
    // 获取当前模型支持的 effort 级别
    const model = getMainLoopModel() ?? ''
    const supportedLevels = getModelEffortLevels(model)

    // 生成帮助文本
    const usageLines = supportedLevels.map(level => {
      const name = tSync(`effort.${level}` as any) || level
      const description = tSync(`effort.description.${level}` as any) || level
      return tSync('effort.command.usageItem', { name, description })
    })

    const options = [...supportedLevels, 'auto'].join('|')
    const header = tSync('effort.command.usageHeader', { options })
    const autoLine = tSync('effort.command.usageAuto')

    onDone(`${header}\n${usageLines.join('\n')}\n${autoLine}`)
    return
  }
  if (!args || args === 'current' || args === 'status') {
    return <ShowCurrentEffort onDone={onDone} />
  }
  const model = getMainLoopModel() ?? ''
  const result = executeEffort(args, model)
  return <ApplyEffortAndClose result={result} onDone={onDone} />
}
