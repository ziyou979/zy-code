/**
 * Goal 模式 React hook。
 * 当 goal 模式激活时，在每轮查询结束后自动 enqueue 续接消息，
 * 驱动模型跨轮次自主推进目标。
 * 参考 src/proactive/useProactive.ts 的实现模式。
 */
import { useEffect, useRef } from 'react'
import { isGoalActive, isGoalPaused, incrementGoalTurn, getGoalState } from '../goal/goalState.js'
import { tSync } from '../i18n/index.js'
import { logForDebugging } from '../utils/debug.js'

export type GoalModeProps = {
  /** 当前是否正在加载（查询进行中） */
  isLoading: boolean
  /** 排队命令数量 */
  queuedCommandsLength: number
  /** 是否有活跃的 JSX UI */
  hasActiveLocalJsxUI: boolean
  /** 将续接消息加入队列 */
  onQueueGoalNudge: (prompt: string) => void
}

/**
 * Goal 模式的核心 hook。
 * 监听 isLoading 从 true→false 的边沿，
 * goal 活跃且非暂停时自动 enqueue 续接消息。
 */
export function useGoalMode(props: GoalModeProps): void {
  const propsRef = useRef(props)
  propsRef.current = props
  const wasLoadingRef = useRef(false)

  useEffect(() => {
    // 检测 isLoading 的 true→false 边沿（一轮查询结束）
    if (wasLoadingRef.current && !props.isLoading) {
      if (isGoalActive() && !isGoalPaused()) {
        const currentProps = propsRef.current
        // 有排队命令或活跃 UI 时跳过
        if (currentProps.queuedCommandsLength > 0 || currentProps.hasActiveLocalJsxUI) {
          logForDebugging('Goal mode: skipping nudge (queued commands or active UI)')
        } else {
          incrementGoalTurn()
          const state = getGoalState()
          const nudge = tSync('goal.nudgeMessage', {
            description: state.description,
            turnCount: String(state.turnCount),
          })
          logForDebugging(
            `Goal mode: enqueuing nudge (turn ${state.turnCount}, elapsed ${(state.elapsedMs / 1000).toFixed(0)}s)`,
          )
          // 短延时避免与流式清理竞态
          setTimeout(() => {
            currentProps.onQueueGoalNudge(nudge)
          }, 500)
        }
      }
    }
    wasLoadingRef.current = props.isLoading
  }, [props.isLoading])
}
