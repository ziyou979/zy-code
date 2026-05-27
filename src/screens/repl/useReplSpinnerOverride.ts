// Spinner 覆盖三态。
// 抽自 screens/REPL.tsx 1243-1245：
// - spinnerMessage / spinnerColor / spinnerShimmerColor 三 useState
// - 三处会同时清空（resetLoadingState、compact_end、内部 reset），
//   每次都写三遍 setter；统一为 resetSpinnerOverride 单次调用
// - 读取仅出现在 SpinnerWithVerb 的 overrideMessage/Color/ShimmerColor 三 prop
// - 写入主要是 autoCompact onCompactProgress 路径（hooks_start 三套色 +
//   compact_start 仅改 message + compact_end 全清）
//
// REPL 主体仍可用单 setter（compact 路径需要分开调），所以三个 setter 都 export。

import { useCallback, useState } from 'react'
import type { Theme } from '../../utils/theme.js'

export type ReplSpinnerOverride = {
  spinnerMessage: string | null
  spinnerColor: keyof Theme | null
  spinnerShimmerColor: keyof Theme | null
  setSpinnerMessage: React.Dispatch<React.SetStateAction<string | null>>
  setSpinnerColor: React.Dispatch<React.SetStateAction<keyof Theme | null>>
  setSpinnerShimmerColor: React.Dispatch<React.SetStateAction<keyof Theme | null>>
  /** 一次清空 message + color + shimmer，免去三连续 setter 调用 */
  resetSpinnerOverride: () => void
}

export function useReplSpinnerOverride(): ReplSpinnerOverride {
  const [spinnerMessage, setSpinnerMessage] = useState<string | null>(null)
  const [spinnerColor, setSpinnerColor] = useState<keyof Theme | null>(null)
  const [spinnerShimmerColor, setSpinnerShimmerColor] = useState<keyof Theme | null>(null)

  const resetSpinnerOverride = useCallback(() => {
    setSpinnerMessage(null)
    setSpinnerColor(null)
    setSpinnerShimmerColor(null)
  }, [])

  return {
    spinnerMessage,
    spinnerColor,
    spinnerShimmerColor,
    setSpinnerMessage,
    setSpinnerColor,
    setSpinnerShimmerColor,
    resetSpinnerOverride,
  }
}
