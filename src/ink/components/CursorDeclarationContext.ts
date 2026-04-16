import { createContext } from 'react'
import type { DOMElement } from '../dom.js'

export type CursorDeclaration = {
  /** 显示列（终端单元格宽度），相对于声明的节点 */
  readonly relativeX: number
  /** 声明的节点内的行号 */
  readonly relativeY: number
  /** ink-box DOMElement，其 yoga 布局提供绝对原点 */
  readonly node: DOMElement
}

/**
 * 声明的游标位置的 Setter。
 *
 * 可选的第二个参数使 `null` 成为有条件的清除：仅在当前已声明的节点
 * 与 `clearIfNode` 匹配时才清除声明。这使得该 hook 对兄弟组件
 * （如列表项）之间转移焦点时安全——没有节点检查的话，新失去焦点的
 * 项的清除操作可能会覆盖新获得焦点的兄弟项的设置，具体取决于
 * layout-effect 的顺序。
 */
export type CursorDeclarationSetter = (
  declaration: CursorDeclaration | null,
  clearIfNode?: DOMElement | null,
) => void

const CursorDeclarationContext = createContext<CursorDeclarationSetter>(
  () => {},
)

export default CursorDeclarationContext
