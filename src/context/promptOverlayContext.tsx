/**
 * Portal for content that floats above the prompt so it escapes
 * FullscreenLayout's bottom-slot `overflowY:hidden` clip.
 *
 * The clip is load-bearing (CC-668: tall pastes squash the ScrollBox
 * without it), but floating overlays use `position:absolute
 * bottom="100%"` to float above the prompt — and Ink's clip stack
 * intersects ALL descendants, so they were clipped to ~1 row.
 *
 * Two channels:
 * - `useSetPromptOverlay` — slash-command suggestion data (structured,
 *   written by PromptInputFooter)
 * - `useSetPromptOverlayDialog` — arbitrary dialog node (e.g.
 *   AutoModeOptInDialog, written by PromptInput)
 *
 * FullscreenLayout reads both and renders them outside the clipped slot.
 *
 * Split into data/setter context pairs so writers never re-render on
 * their own writes — the setter contexts are stable.
 */
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react'
import type { SuggestionItem } from '../components/PromptInput/PromptInputFooterSuggestions.js'
import { logForDebugging } from '../utils/debug.js'
export type PromptOverlayData = {
  suggestions: SuggestionItem[]
  selectedSuggestion: number
  maxColumnWidth?: number
}
type Setter<T> = (d: T | null) => void
const DataContext = createContext<PromptOverlayData | null>(null)
const SetContext = createContext<Setter<PromptOverlayData> | null>(null)
const DialogContext = createContext<ReactNode>(null)
const SetDialogContext = createContext<Setter<ReactNode> | null>(null)
export function PromptOverlayProvider({ children }: { children: ReactNode }) {
  const [data, setData] = useState<PromptOverlayData | null>(null)
  const [dialog, setDialog] = useState<ReactNode>(null)
  return (
    <SetContext.Provider value={setData}>
      <SetDialogContext.Provider value={setDialog}>
        <DataContext.Provider value={data}>
          {<DialogContext.Provider value={dialog}>{children}</DialogContext.Provider>}
        </DataContext.Provider>
      </SetDialogContext.Provider>
    </SetContext.Provider>
  )
}
export function usePromptOverlay() {
  return useContext(DataContext)
}
export function usePromptOverlayDialog() {
  return useContext(DialogContext)
}

/**
 * Register suggestion data for the floating overlay. Clears on unmount.
 * No-op outside the provider (non-fullscreen renders inline instead).
 */
export function useSetPromptOverlay(data: PromptOverlayData | null) {
  const set = useContext(SetContext)
  useEffect(() => {
    if (!set) {
      return
    }
    set(data)
    return () => set(null)
  }, [set, data])
}

/**
 * 注册一个浮动在提示符上方的对话框节点，卸载时自动清除。
 * 在 provider 外部为空操作（非全屏模式改为内联渲染）。
 *
 * 使用 useEffect 而非 useLayoutEffect：避免在 commit 阶段调用 set(node)
 * 创建嵌套更新。useEffect 的 cleanup 在 paint 后执行，set(null) 不会
 * 与其他 effect 清理交互触发 "Maximum update depth exceeded" 崩溃。
 * 同类函数 useSetPromptOverlay 也使用 useEffect，保持一致。
 */
export function useSetPromptOverlayDialog(node: ReactNode) {
  const set = useContext(SetDialogContext)
  // 诊断计数器：记录 effect 运行次数，便于排查无限循环
  useEffect(() => {
    if (!set) {
      return
    }
    set(node)
    return () => {
      set(null)
    }
  }, [set, node])
}
