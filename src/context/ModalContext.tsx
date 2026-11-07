import { createContext, type RefObject, useContext } from 'react'
import type { ScrollBoxHandle } from '../ink/components/ScrollBox.js'

/**
 * FullscreenLayout 在 `modal` 插槽中渲染内容时设置此上下文；该插槽是用于
 * slash command 对话框、绝对定位并锚定底部的面板。消费者用它来：
 *
 * - 避免重复绘制顶层边框：`Pane` 跳过横跨终端宽度的 `Divider`
 *   （FullscreenLayout 已绘制 ▔ 分隔线）。
 * - 按可用行数计算 Select 分页：modal 内部区域小于终端高度（终端行数减去
 *   transcript 预览和分隔线），若仍按 `useTerminalSize().rows` 限制可见选项数就会溢出。
 * - 切换 tab 时重置滚动：Tabs 以 `selectedTabIndex` 作为 ScrollBox 的 key，
 *   切换时重新挂载，让 scrollTop 自然归零，避免依赖 scrollTo() 的调用时机。
 *
 * null 表示当前不在 modal 插槽内。
 */
type ModalCtx = {
  rows: number
  columns: number
  scrollRef: RefObject<ScrollBoxHandle | null> | null
}
export const ModalContext = createContext<ModalCtx | null>(null)
export function useIsInsideModal() {
  return useContext(ModalContext) !== null
}

/**
 * 位于 Modal 内时返回内容区域可用的行列数，否则回退到传入的终端尺寸。
 * 组件需要限制可见内容高度时应使用它，而不是 `useTerminalSize()`，因为 modal
 * 的内部区域小于整个终端。
 */
export function useModalOrTerminalSize(fallback: { rows: number; columns: number }) {
  const ctx = useContext(ModalContext)
  return ctx
    ? {
        rows: ctx.rows,
        columns: ctx.columns,
      }
    : fallback
}
export function useModalScrollRef() {
  return useContext(ModalContext)?.scrollRef ?? null
}
