import { useCallback, useContext, useLayoutEffect, useRef } from 'react'
import CursorDeclarationContext from '../components/CursorDeclarationContext.js'
import type { DOMElement } from '../dom.js'

/**
 * 声明每帧结束后终端光标应停靠的位置。
 *
 * 终端模拟器会在物理光标位置渲染 IME 预编辑文本，屏幕阅读器/
 * 屏幕放大器也会跟踪原生光标——因此将光标停靠在文本输入的插入符
 * 处可以让 CJK 输入法内联显示，并让辅助工具跟随输入。
 *
 * 返回一个 ref 回调，用于附加到包含输入的 Box 上。
 * 声明的 (line, column) 会相对于该 Box 的 nodeCache rect
 * （由 renderNodeToOutput 填充）进行解释。
 *
 * 时序：ref 挂载和 useLayoutEffect 都在 React 的 layout 阶段触发
 * ——在 resetAfterCommit 调用 scheduleRender 之后。scheduleRender
 * 通过 queueMicrotask 延迟 onRender，因此 onRender 会在 layout
 * 效果提交之后运行，并在第一帧读取到最新的声明（无按键延迟）。
 * 测试环境使用 onImmediateRender（同步，无微任务），因此测试通过
 * 在 render 后显式调用 ink.onRender() 来补偿。
 */
export function useDeclaredCursor({
  line,
  column,
  active,
}: {
  line: number
  column: number
  active: boolean
}): (element: DOMElement | null) => void {
  const setCursorDeclaration = useContext(CursorDeclarationContext)
  const nodeRef = useRef<DOMElement | null>(null)

  const setNode = useCallback((node: DOMElement | null) => {
    nodeRef.current = node
  }, [])

  // 激活时无条件设置。未激活时条件清除（仅当当前声明的节点是我们的）。
  // 节点标识检查处理两种风险：
  //   1. 其他位置的 memo() 激活实例（例如 memo'd Footer 中的搜索输入）
  //      不会重新渲染此提交——此处重新渲染的非激活实例不能覆盖它。
  //   2. 兄弟交接（菜单焦点在列表项之间移动）——当焦点逆兄弟顺序移动时，
  //      新非激活项的 effect 在新激活项的 set 之后运行。没有节点检查
  //      就会覆盖。
  // 无依赖数组：必须在每次提交时重新声明，这样激活实例才能在另一个
  // 实例的卸载清理或兄弟交接将其清空后重新获取声明。
  useLayoutEffect(() => {
    const node = nodeRef.current
    if (active && node) {
      setCursorDeclaration({ relativeX: column, relativeY: line, node })
    } else {
      setCursorDeclaration(null, node)
    }
  })

  // 卸载时清除（有条件——另一个实例可能已接管）。
  // 使用空依赖的独立 effect，这样清理只在卸载时触发一次，而不是
  // 每次 line/column 变化时都触发，否则会在两次提交之间短暂清空。
  useLayoutEffect(() => {
    return () => {
      setCursorDeclaration(null, nodeRef.current)
    }
  }, [setCursorDeclaration])

  return setNode
}
