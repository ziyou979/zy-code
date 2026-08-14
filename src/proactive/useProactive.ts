import { useEffect, useRef } from 'react'
import { isProactiveActive } from './index.js'

type ProactiveProps = {
  isLoading: boolean
  queuedCommandsLength: number
  hasActiveLocalJsxUI: boolean
  isInPlanMode: boolean
  onSubmitTick: (prompt: string) => void
  onQueueTick: (prompt: string) => void
}

/**
 * 主动模式的 React hook。
 * 当 proactive mode 激活时，定期发送 tick 提示以驱动自主行为。
 */
export function useProactive(props: ProactiveProps): void {
  const propsRef = useRef(props)
  propsRef.current = props

  useEffect(() => {
    if (!isProactiveActive()) {
      return
    }

    const TICK_INTERVAL = 30000 // 30 秒
    const interval = setInterval(() => {
      const p = propsRef.current
      // 在以下情况跳过 tick：加载中、有排队命令、有活跃 UI、计划模式中
      if (p.isLoading || p.queuedCommandsLength > 0 || p.hasActiveLocalJsxUI || p.isInPlanMode) {
        return
      }
      p.onQueueTick('<tick>')
    }, TICK_INTERVAL)

    return () => clearInterval(interval)
  }, [])
}
