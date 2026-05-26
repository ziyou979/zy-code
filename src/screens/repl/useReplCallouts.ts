// REPL 横幅 / 提示卡（callouts）簇 state。
// 抽自 screens/REPL.tsx：showEffortCallout / showDesktopUpsellStartup 两个本地 state +
// showRemoteCallout（AppState selector）。
// 三个标志互相独立，只在 focusedInputDialog 判定与对应横幅渲染时被消费；
// 抽出后 REPL 主体可少 3 个 useState/useAppState 调用。

import { useState } from 'react'
import { shouldShowDesktopUpsellStartup } from '../../components/DesktopUpsell/DesktopUpsellStartup.js'
import { useAppState } from '../../state/AppState.js'
import { getSettingsForSource } from '../../utils/settings/settings.js'

export type ReplCallouts = {
  showEffortCallout: boolean
  setShowEffortCallout: (next: boolean) => void
  /** 由 AppState.showRemoteCallout 投影；REPL 通过 setAppState 直接关闭，本 hook 不提供 setter。 */
  showRemoteCallout: boolean
  showDesktopUpsellStartup: boolean
  setShowDesktopUpsellStartup: (next: boolean) => void
}

export function useReplCallouts(): ReplCallouts {
  const [showEffortCallout, setShowEffortCallout] = useState(() => {
    // 如果 onboarding 已经持久化了 effortLevel 则不弹出
    const settings = getSettingsForSource('userSettings')
    return !settings?.effortLevel
  })
  const showRemoteCallout = useAppState((s) => s.showRemoteCallout)
  const [showDesktopUpsellStartup, setShowDesktopUpsellStartup] = useState(() =>
    shouldShowDesktopUpsellStartup(),
  )
  return {
    showEffortCallout,
    setShowEffortCallout,
    showRemoteCallout,
    showDesktopUpsellStartup,
    setShowDesktopUpsellStartup,
  }
}
