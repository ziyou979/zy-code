import type { LocalCommandCall } from '../types.js'
import { clearConversation } from './conversation.js'

export const call: LocalCommandCall = async (_, context) => {
  await clearConversation(context)
  // 返回 skip：/clear 的目的是清空会话，不应将命令本身和空 stdout 追加回消息列表。
  // 返回 text 会走 onQuery 路径追加 [userMessage, stdout]，导致：
  // 1. 内容从多消息骤降至 2 条，grew=false，stickyScroll 已打破时不滚动到底部
  // 2. runQuery finally 块曾无条件生成 turn_duration 消息（"⣝ 处理完成，耗时 0 秒"）
  // skip 使 processSlashCommand 返回空消息列表，handlePromptSubmit 走 else 分支，
  // 不调用 onQuery，消息保持 clearConversation 清空后的状态（[] 或 hook 消息）。
  return { type: 'skip' }
}
