import type { LocalCommandCall } from '../../types/command.js'
import {
  type EffortValue,
  getDisplayedEffortLevel,
  getEffortEnvOverride,
} from '../../utils/effort.js'
import { executeEffort, showCurrentEffort } from './effort.js'

const COMMON_HELP_ARGS = ['help', '-h', '--help']

/**
 * /effort 的非交互（local）入口：复用已有纯函数 executeEffort / showCurrentEffort，
 * 直接落 setAppState 后通过 stdout 返回。
 *
 * 注意：showCurrentEffort 内部用 hooks/useMainLoopModel 在 jsx 端拿模型；
 * local 端没有 React tree，所以从 appState 直接读 mainLoopModel。
 */
export const call: LocalCommandCall = async (rawArgs, context) => {
  const args = (rawArgs ?? '').trim()

  if (COMMON_HELP_ARGS.includes(args)) {
    return {
      type: 'text',
      value:
        'Usage: /effort [low|medium|high|max|auto]\n\nEffort levels:\n- low: Quick, straightforward implementation\n- medium: Balanced approach with standard testing\n- high: Comprehensive implementation with extensive testing\n- max: Maximum capability with deepest reasoning (Opus 4.6 only)\n- auto: Use the default effort level for your model',
    }
  }

  const state = context.getAppState()

  if (!args || args === 'current' || args === 'status') {
    // 复用 jsx 端 ShowCurrentEffort 的等价逻辑：appStateEffort + mainLoopModel
    const effortValue = state.effortValue as EffortValue | undefined
    const model = state.mainLoopModel ?? ''
    const envOverride = getEffortEnvOverride()
    const effective = envOverride === null ? undefined : (envOverride ?? effortValue)
    if (effective === undefined) {
      const level = getDisplayedEffortLevel(model, effortValue)
      return { type: 'text', value: `Effort level: auto (currently ${level})` }
    }
    const { message } = showCurrentEffort(effortValue, model)
    return { type: 'text', value: message }
  }

  const result = executeEffort(args)
  if (result.effortUpdate) {
    context.setAppState((prev) => ({
      ...prev,
      effortValue: result.effortUpdate!.value,
    }))
  }
  return { type: 'text', value: result.message }
}
