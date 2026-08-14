import { useState } from 'react'
import { useInterval } from 'usehooks-ts'

export type MemoryUsageStatus = 'normal' | 'high' | 'critical'

export type MemoryUsageInfo = {
  heapUsed: number
  status: MemoryUsageStatus
}

const HIGH_MEMORY_THRESHOLD = 1.5 * 1024 * 1024 * 1024 // 1.5GB in bytes
const CRITICAL_MEMORY_THRESHOLD = 2.5 * 1024 * 1024 * 1024 // 2.5GB in bytes

/**
 * 监控 Node.js 进程内存用量的 hook。
 * 每 10 秒轮询一次；状态为 'normal' 时返回 null。
 */
export function useMemoryUsage(): MemoryUsageInfo | null {
  const [memoryUsage, setMemoryUsage] = useState<MemoryUsageInfo | null>(null)

  useInterval(() => {
    const heapUsed = process.memoryUsage().heapUsed
    const status: MemoryUsageStatus =
      heapUsed >= CRITICAL_MEMORY_THRESHOLD
        ? 'critical'
        : heapUsed >= HIGH_MEMORY_THRESHOLD
          ? 'high'
          : 'normal'
    setMemoryUsage((prev) => {
      // 状态为 'normal' 时直接返回：此时界面不显示任何内容，heapUsed 也无关紧要。
      // 超过 99% 的用户不会达到 1.5GB，这可避免每 10 秒重渲染整个 Notifications 子树。
      if (status === 'normal') {
        return prev === null ? prev : null
      }
      return { heapUsed, status }
    })
  }, 10_000)

  return memoryUsage
}
