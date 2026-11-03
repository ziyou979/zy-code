/**
 * 将内容 Portal 到 prompt 上方，使其避开 FullscreenLayout 底部插槽的
 * `overflowY:hidden` 裁剪。
 *
 * 该裁剪不能移除（CC-668：否则粘贴长文本会挤压 ScrollBox），但浮动 Overlay 通过
 * `position:absolute; bottom="100%"` 显示在 prompt 上方，而 Ink 会对所有后代叠加
 * 裁剪区域，导致它们只剩约一行可见。
 *
 * 两条通道：
 * - `useSetPromptOverlay`：slash command 的结构化建议数据，由 PromptInputFooter 写入
 * - `useSetPromptOverlayDialog`：任意对话框节点（如 AutoModeOptInDialog），由 PromptInput 写入
 *
 * FullscreenLayout 读取两者，并在受裁剪插槽之外渲染。
 *
 * 数据与 setter 拆成两组 context，使写入方不会因自己的写入而重新渲染；
 * setter context 的引用保持稳定。
 */
import { createContext, type ReactNode, useContext, useEffect, useRef, useState } from 'react'
import type { SuggestionItem } from '../components/PromptInput/PromptInputFooterSuggestions.js'
import { logForDebugging } from '../services/infra/debug.js'
export type PromptOverlayData = {
  suggestions: SuggestionItem[]
  selectedSuggestion: number
  hoveredSuggestionId: string | null
  maxColumnWidth?: number
  onAcceptSuggestion?: (index: number) => void
  onClickSuggestion?: (index: number) => void
  onHoverSuggestion: (id: string | null) => void
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
 * 注册浮动 Overlay 的建议数据，卸载时清除。
 * 在 provider 外不执行操作（非全屏模式会改为原地渲染）。
 */
export function useSetPromptOverlay(data: PromptOverlayData | null) {
  const set = useContext(SetContext)
  useEffect(() => {
    set?.(data)
  }, [set, data])
  useEffect(
    () => () => {
      set?.(null)
    },
    [set],
  )
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
