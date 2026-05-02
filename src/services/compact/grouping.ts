import type { Message } from '../../types/message.js'

/**
 * 按 API 轮次边界对消息进行分组：每个 API 往返一个组。
 * 当新的助手响应开始时触发边界（与之前的助手不同的
 * message.id）。对于格式良好的对话，这是 API 安全的分割点 —
 * API 契约要求每个 tool_use 在下一个助手轮次之前被解决，
 * 所以配对有效性来自助手 ID 边界。对于格式不良的输入
 * （恢复/截断后的悬空 tool_use），分叉中的
 * ensureToolResultPairing 在 API 时修复分割。
 *
 * 替换了之前的人工轮次分组（仅在真实用户提示处设置边界），
 * 采用更细粒度的 API 轮次分组，允许响应式压缩在
 * 单提示代理会话（SDK/CCR/eval 调用者）上运行，
 * 其中整个工作负载是一个人工轮次。
 *
 * 提取到单独的文件以打破 compact.ts ↔ compactMessages.ts
 * 循环（CC-1180）— 循环改变了模块初始化顺序，足以在
 * CI 分片-2 中暴露 ws CJS/ESM 解析竞争条件。
 */
export function groupMessagesByApiRound(messages: Message[]): Message[][] {
  const groups: Message[][] = []
  let current: Message[] = []
  // 最近看到的助手的 message.id。这是唯一的
  // 边界门：来自同一 API 响应的流式块共享一个
  // id，所以边界只在真正的新轮次开始时触发。
  // normalizeMessages 为每个内容块生成一个 AssistantMessage，并且
  // StreamingToolExecutor 在块之间实时交错 tool_results
  // （生成顺序，而非拼接顺序 — 参见 query.ts:613）。id 检查
  // 正确地将 `[tu_A(id=X), result_A, tu_B(id=X)]` 保持在同一组中。
  let lastAssistantId: string | undefined

  // 在格式良好的对话中，API 契约保证每个
  // tool_use 在下一个助手轮次之前被解决，所以 lastAssistantId
  // 单独就足以作为边界门。跟踪未解决的 tool_use ID
  // 只在对话格式不良时（恢复后或 max_tokens 截断后的悬空 tool_use）
  // 才有用 — 在这种情况下它会永远关闭门，将所有后续轮次合并
  // 到一个组中。我们让这些边界触发；摘要分叉自己的
  // ensureToolResultPairing（zy.ts:1136）在 API 时修复悬空的 tu。
  for (const msg of messages) {
    if (msg.type === 'assistant' && msg.message.id !== lastAssistantId && current.length > 0) {
      groups.push(current)
      current = [msg]
    } else {
      current.push(msg)
    }
    if (msg.type === 'assistant') {
      lastAssistantId = msg.message.id
    }
  }

  if (current.length > 0) {
    groups.push(current)
  }
  return groups
}
