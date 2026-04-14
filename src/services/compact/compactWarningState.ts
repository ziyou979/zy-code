import { createStore } from '../../state/store.js'

/**
 * 跟踪是否应抑制"自动压缩前剩余的上下文"警告。
 * 成功压缩后立即抑制，因为在下次 API 响应之前
 * 我们没有准确的令牌计数。
 */
export const compactWarningStore = createStore<boolean>(false)

/** 抑制压缩警告。在成功压缩后调用。 */
export function suppressCompactWarning(): void {
  compactWarningStore.setState(() => true)
}

/** 清除压缩警告抑制。在新的压缩尝试开始时调用。 */
export function clearCompactWarningSuppression(): void {
  compactWarningStore.setState(() => false)
}
