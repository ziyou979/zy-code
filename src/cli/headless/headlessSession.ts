// HeadlessSession — headless/SDK 模式下 runHeadlessStreaming 的共享会话状态容器。
//
// 设计:
// - 参照 ReplStore（src/state/ReplStore.ts）的"状态容器"思路,但 headless 无 React
//   渲染,故为单层 plain object,不引入 createStore / useSyncExternalStore。
// - Phase 1 仅收拢会话消息数组:显式 append 统一走 appendMessages();读取与传参直接
//   使用 messages 引用。
// - 注意:ask()（QueryEngine）仍按引用原地 push messages,故那条 "avoid passing around
//   a mutable array" 的 TODO 尚未完全关闭——彻底封闭需改 ask() 契约,留待后续 Phase。

import type { Message } from 'src/types/message.js'

export type HeadlessSession = {
  /** 会话消息列表。ask() 按引用原地 push;读取/传参直接用此引用。 */
  readonly messages: Message[]
  /** 追加消息——集中显式 append 的唯一入口,后续可在此加入记账/校验。 */
  appendMessages(...msgs: Message[]): void
}

export type CreateHeadlessSessionParams = {
  /** 初始消息;session 持有同一引用,保持既有 aliasing 语义不变。 */
  initialMessages: Message[]
}

export function createHeadlessSession({
  initialMessages,
}: CreateHeadlessSessionParams): HeadlessSession {
  const messages = initialMessages
  return {
    messages,
    appendMessages(...msgs: Message[]): void {
      messages.push(...msgs)
    },
  }
}
