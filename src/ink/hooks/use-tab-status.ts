import { useContext, useEffect, useRef } from 'react'
import {
  CLEAR_TAB_STATUS,
  supportsTabStatus,
  tabStatus,
  wrapForMultiplexer,
} from '../termio/osc.js'
import type { Color } from '../termio/types.js'
import { TerminalWriteContext } from '../useTerminalNotification.js'
import { tSync } from '../../i18n/index.js'

export type TabStatusKind = 'idle' | 'busy' | 'waiting'

const rgb = (r: number, g: number, b: number): Color => ({
  type: 'rgb',
  r,
  g,
  b,
})

// 根据 OSC 21337 使用指南的建议映射。
const TAB_STATUS_PRESETS: Record<
  TabStatusKind,
  { indicator: Color; status: string; statusColor: Color }
> = {
  idle: {
    indicator: rgb(0, 215, 95),
    status: tSync('spinner.idle'),
    statusColor: rgb(136, 136, 136),
  },
  busy: {
    indicator: rgb(255, 149, 0),
    status: 'Working…',
    statusColor: rgb(255, 149, 0),
  },
  waiting: {
    indicator: rgb(95, 135, 255),
    status: 'Waiting',
    statusColor: rgb(95, 135, 255),
  },
}

/**
 * 声明式设置标签页状态指示器 (OSC 21337)。
 *
 * 在标签页侧边栏发射一个彩色圆点 + 简短状态文本。不支持 OSC 21337
 * 的终端会静默丢弃该序列，因此可以安全地无条件调用。已针对
 * tmux/screen 透传进行包装。
 *
 * 传入 `null` 表示退出。如果之前设置过状态，切换到 `null` 时会
 * 发射 CLEAR_TAB_STATUS，确保会话中途关闭时不会残留圆点。
 * 进程退出时的清理由 ink.tsx 的卸载路径处理。
 */
export function useTabStatus(kind: TabStatusKind | null): void {
  const writeRaw = useContext(TerminalWriteContext)
  const prevKindRef = useRef<TabStatusKind | null>(null)

  useEffect(() => {
    // 当 kind 从非 null 切换到 null（例如用户在会话中关闭
    // showStatusInTerminalTab）时，清除残留的圆点。
    if (kind === null) {
      if (prevKindRef.current !== null && writeRaw && supportsTabStatus()) {
        writeRaw(wrapForMultiplexer(CLEAR_TAB_STATUS))
      }
      prevKindRef.current = null
      return
    }

    prevKindRef.current = kind
    if (!writeRaw || !supportsTabStatus()) return
    writeRaw(wrapForMultiplexer(tabStatus(TAB_STATUS_PRESETS[kind])))
  }, [kind, writeRaw])
}
