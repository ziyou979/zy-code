// Spinner 覆盖三态 + onCompactProgress 适配。
// 抽自 screens/REPL.tsx 1243-1245 + 2201-2224。
//
// - spinnerMessage / spinnerColor / spinnerShimmerColor 三 useState
// - resetSpinnerOverride：一次清空三态（resetLoadingState、compact_end 用）
// - onCompactProgress：把 compact 进度事件映射成 spinner 文案/配色，
//   hooks_start 设三态，compact_start 仅改 message，compact_end 全清。
//   抽进来后 getToolUseContext 只需把这个 callback 透传给 compact 服务，
//   不再持有具体 setter。
//
// 三个独立 setter 仍 export 给 future flexibility，但当前消费者只剩
// onCompactProgress 与 resetSpinnerOverride。

import { useCallback, useState } from 'react'
import { tSync } from '../../i18n/index.js'
import type { CompactProgressEvent } from '../../Tool.js'
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
  /** 把 compact 进度事件映射成 spinner 文案；getToolUseContext 透传给 compact */
  onCompactProgress: (event: CompactProgressEvent) => void
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

  const onCompactProgress = useCallback(
    (event: CompactProgressEvent) => {
      switch (event.type) {
        case 'hooks_start':
          setSpinnerColor('ZyBlue_FOR_SYSTEM_SPINNER')
          setSpinnerShimmerColor('ZyBlueShimmer_FOR_SYSTEM_SPINNER')
          setSpinnerMessage(
            tSync('spinner.hooksRunning', {
              hookType:
                event.hookType === 'pre_compact'
                  ? 'PreCompact'
                  : event.hookType === 'post_compact'
                    ? 'PostCompact'
                    : 'SessionStart',
            }),
          )
          break
        case 'compact_start':
          setSpinnerMessage(tSync('spinner.compacting'))
          break
        case 'compact_end':
          resetSpinnerOverride()
          break
      }
    },
    [resetSpinnerOverride],
  )

  return {
    spinnerMessage,
    spinnerColor,
    spinnerShimmerColor,
    setSpinnerMessage,
    setSpinnerColor,
    setSpinnerShimmerColor,
    resetSpinnerOverride,
    onCompactProgress,
  }
}
