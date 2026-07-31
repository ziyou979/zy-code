import { isEnvTruthy } from '../services/infra/envUtils.js'

// JediTerm 的 IME 预编辑串会作为 inline inlay 追加到终端逻辑行。
// 提前换行以预留常见多音节拼音的空间，避免光标靠近右边界时由
// 预编辑文本触发终端软换行。该余量只影响 Windows JediTerm。
const JETBRAINS_IME_PREEDIT_COLUMNS = 12

/**
 * 是否使用终端原生光标。
 *
 * JediTerm 会把 Windows IME 的预编辑装饰绑定到物理光标。只移动一个
 * 隐藏光标时，装饰可能与拼音字母重叠成短横杠；显示原生光标并停止
 * 绘制反色光标后，预编辑位置和终端的光标状态保持一致。
 */
export function shouldUseNativeCursor(): boolean {
  if (isEnvTruthy(process.env.ZY_CODE_ACCESSIBILITY)) {
    return true
  }

  if (process.env.ZY_CODE_NATIVE_CURSOR !== undefined) {
    return isEnvTruthy(process.env.ZY_CODE_NATIVE_CURSOR)
  }

  return (
    process.platform === 'win32' && process.env.TERMINAL_EMULATOR?.includes('JetBrains') === true
  )
}

/**
 * 返回为 JediTerm IME 预编辑文本预留空间后的输入换行宽度。
 * 容器仍使用完整宽度，仅文本提前换行。
 */
export function getImeSafeTextColumns(columns: number): number {
  if (
    process.platform !== 'win32' ||
    process.env.TERMINAL_EMULATOR !== 'JetBrains-JediTerm' ||
    !shouldUseNativeCursor()
  ) {
    return columns
  }

  return Math.max(2, columns - JETBRAINS_IME_PREEDIT_COLUMNS)
}
