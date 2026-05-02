import { useSyncExternalStore } from 'react'
import { compactWarningStore } from './compactWarningState.js'

/**
 * React 钩子，订阅压缩警告抑制状态。
 *
 * 放在单独的文件中，以便 compactWarningState.ts 保持无 React：
 * microCompact.ts 导入纯状态函数，将该模块图拉入 React
 * 会将其拖入打印模式启动路径。
 */
export function useCompactWarningSuppression(): boolean {
  return useSyncExternalStore(compactWarningStore.subscribe, compactWarningStore.getState)
}
