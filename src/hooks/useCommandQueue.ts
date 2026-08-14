import { useSyncExternalStore } from 'react'
import type { QueuedCommand } from '../types/textInputTypes.js'
import {
  getCommandQueueSnapshot,
  subscribeToCommandQueue,
} from '../services/input/messageQueueManager.js'

/**
 * 订阅统一命令队列的 React hook。
 * 返回冻结数组，仅在队列发生变化时更换引用，组件也只会在此时重新渲染。
 */
export function useCommandQueue(): readonly QueuedCommand[] {
  return useSyncExternalStore(subscribeToCommandQueue, getCommandQueueSnapshot)
}
