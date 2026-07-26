import { isEnvTruthy } from '../services/infra/envUtils.js'

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
