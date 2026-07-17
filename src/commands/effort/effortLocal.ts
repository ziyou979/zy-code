import { tSync } from '../../i18n/index.js'
import type { LocalCommandCall } from '../types.js'
import {
  type EffortLevel,
  getDisplayedEffortLevel,
  getEffortEnvOverride,
  getModelEffortLevels,
} from '../../services/effort/effort.js'
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
  const state = context.getAppState()

  if (COMMON_HELP_ARGS.includes(args)) {
    // 获取当前模型支持的 effort 级别
    const model = state.mainLoopModel ?? ''
    const supportedLevels = getModelEffortLevels(model)

    // 生成帮助文本
    const usageLines = supportedLevels.map((level) => {
      const name = tSync(`effort.${level}`) || level
      const description = tSync(`effort.description.${level}`) || level
      return tSync('effort.command.usageItem', { name, description })
    })

    const options = [...supportedLevels, 'auto'].join('|')
    const header = tSync('effort.command.usageHeader', { options })
    const autoLine = tSync('effort.command.usageAuto')

    return {
      type: 'text',
      value: `${header}\n${usageLines.join('\n')}\n${autoLine}`,
    }
  }

  if (!args || args === 'current' || args === 'status') {
    // 复用 jsx 端 ShowCurrentEffort 的等价逻辑：appStateEffort + mainLoopModel
    const effortValue = state.effortValue as EffortLevel | undefined
    const model = state.mainLoopModel ?? ''
    const envOverride = getEffortEnvOverride()
    const effective = envOverride === null ? undefined : (envOverride ?? effortValue)
    if (effective === undefined) {
      const level = getDisplayedEffortLevel(model, effortValue)
      const levelName = tSync(`effort.${level}`) || level
      return { type: 'text', value: tSync('effort.command.currentAuto', { level: levelName }) }
    }
    const { message } = showCurrentEffort(effortValue, model)
    return { type: 'text', value: message }
  }

  const model = state.mainLoopModel ?? ''
  const result = executeEffort(args, model)
  if (result.effortUpdate) {
    context.setAppState((prev) => ({
      ...prev,
      effortValue: result.effortUpdate!.value,
    }))
  }
  return { type: 'text', value: result.message }
}
