import type { LocalCommandCall } from '../../types/command.js'
import { activateGoal, deactivateGoal, isGoalActive, getGoalState } from '../../goal/goalState.js'
import { tSync } from '../../i18n/index.js'
import { logForDebugging } from '../../utils/debug.js'

export const call: LocalCommandCall = async (args) => {
  const trimmedArgs = args.trim()

  // /goal stop — 停用目标模式
  if (trimmedArgs === 'stop' || trimmedArgs === 'off') {
    if (!isGoalActive()) {
      return { type: 'text', value: tSync('goal.notActive') }
    }
    const finalState = getGoalState()
    deactivateGoal()
    logForDebugging(`/goal stopped after ${finalState.turnCount} turns`)
    return {
      type: 'text',
      value: tSync('goal.deactivated', {
        turnCount: String(finalState.turnCount),
        elapsed: formatElapsed(finalState.elapsedMs),
        tokens: String(finalState.inputTokens + finalState.outputTokens),
        cost: finalState.costUSD.toFixed(4),
      }),
    }
  }

  // /goal（无参数）— 显示当前状态
  if (!trimmedArgs) {
    if (!isGoalActive()) {
      return { type: 'text', value: tSync('goal.notActive') }
    }
    const state = getGoalState()
    return {
      type: 'text',
      value: tSync('goal.status', {
        description: state.description,
        turnCount: String(state.turnCount),
        elapsed: formatElapsed(state.elapsedMs),
        tokens: String(state.inputTokens + state.outputTokens),
        cost: state.costUSD.toFixed(4),
      }),
    }
  }

  // /goal <description> — 激活目标模式
  if (isGoalActive()) {
    return { type: 'text', value: tSync('goal.alreadyActive') }
  }

  activateGoal(trimmedArgs)
  logForDebugging(`/goal activated: "${trimmedArgs}"`)

  // 返回结构化 prompt 引导模型
  return {
    type: 'text',
    value: tSync('goal.activatedPrompt', { description: trimmedArgs }),
  }
}

/** 格式化毫秒为人类可读的耗时 */
function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return `${hours}h ${remainingMinutes}m`
}
