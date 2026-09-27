import { tSync } from '../../i18n/index.js'
import type { Message, SystemQuietLoopMessage } from '../../types/message.js'
import { findToolByName, type Tools } from '../../tools/tool.js'
import { SCHEDULE_WAKEUP_TOOL_NAME } from '../../tools/ScheduleWakeupTool/prompt.js'

function getLoopObjective(message: Message | undefined): string | undefined {
  if (message?.type !== 'user' || !message.isMeta) {
    return undefined
  }
  const blocks = message.message.content
  if (blocks.length !== 1 || blocks[0]?.type !== 'text') {
    return undefined
  }
  const text = blocks[0].text.trim()
  return text.startsWith('<<autonomous-loop-dynamic>>') ? text : undefined
}

/** 只识别完整、成功、无写操作且没有面向用户正文的观察轮次。 */
function readQuietTurn(
  messages: readonly Message[],
  start: number,
  tools: Tools,
): { end: number; objective: string } | undefined {
  const first = messages[start]
  const promptIndex =
    first?.type === 'system' && first.subtype === 'scheduled_task_fire' ? start + 1 : start
  const objective = getLoopObjective(messages[promptIndex])
  if (!objective) {
    return undefined
  }

  const pending = new Set<string>()
  let wakeupId: string | undefined
  let wakeupCompleted = false
  let end = promptIndex + 1
  for (; end < messages.length; end++) {
    const message = messages[end]!
    if (message.type === 'user') {
      const blocks = message.message.content
      if (blocks.some((block) => block.type !== 'tool_result')) {
        break
      }
      const output = message.toolUseResult
      // 转后台不是观察完成；中断或失败也不能被模型的 noop 声明隐藏。
      if (output && typeof output === 'object') {
        if (
          ('backgroundTaskId' in output && output.backgroundTaskId) ||
          ('interrupted' in output && output.interrupted === true) ||
          ('isError' in output && output.isError === true)
        ) {
          return undefined
        }
      }
      for (const block of blocks) {
        if (block.type !== 'tool_result' || block.isError || !pending.delete(block.toolCallId)) {
          return undefined
        }
        if (block.toolCallId === wakeupId) {
          wakeupCompleted = true
        }
      }
    } else if (message.type === 'assistant') {
      if (message.isApiErrorMessage || message.error) {
        return undefined
      }
      for (const block of message.message.content) {
        if (block.type === 'thinking' || block.type === 'redacted_thinking') {
          continue
        }
        if (block.type === 'text' && !block.text.trim()) {
          continue
        }
        if (block.type !== 'tool_call') {
          return undefined
        }
        if (block.name === SCHEDULE_WAKEUP_TOOL_NAME) {
          // 停止、替换目标或重复安排都不能算作同一监控的空轮次。
          if (
            wakeupId ||
            block.input.noop !== true ||
            block.input.stop === true ||
            block.input.prompt !== objective
          ) {
            return undefined
          }
          wakeupId = block.id
        } else {
          const tool = findToolByName(tools, block.name)
          if (!tool) {
            return undefined
          }
          const parsed = tool.inputSchema.safeParse(block.input)
          if (!parsed.success || !tool.isReadOnly(parsed.data)) {
            return undefined
          }
        }
        pending.add(block.id)
      }
    } else if (message.type === 'system') {
      if (message.subtype === 'scheduled_task_fire') {
        break
      }
      if (message.subtype !== 'turn_duration') {
        return undefined
      }
    } else if (message.type !== 'progress') {
      // 不吞掉附件、权限请求或其他尚未明确可隐藏的消息。
      return undefined
    }
  }
  return wakeupCompleted && pending.size === 0 ? { end, objective } : undefined
}

/**
 * 仅生成显示投影；不修改原消息或 AppState，也不裁剪模型上下文。
 * 计数从 transcript 重建，恢复会话时无需维护第二份可变状态。
 */
export function collapseQuietLoopTurns(
  messages: readonly Message[],
  tools: Tools,
  enabled: boolean,
): readonly Message[] {
  if (!enabled) {
    return messages
  }
  const result: Message[] = []
  let streak: { objective: string; count: number; message: SystemQuietLoopMessage } | undefined
  for (let index = 0; index < messages.length; ) {
    const turn = readQuietTurn(messages, index, tools)
    if (!turn) {
      result.push(messages[index]!)
      streak = undefined
      index++
      continue
    }
    if (streak?.objective === turn.objective) {
      streak.count++
      streak.message.content = tSync('summary.loop.quietChecks', { count: streak.count })
    } else {
      const first = messages[index]!
      const summary: SystemQuietLoopMessage = {
        type: 'system',
        subtype: 'quiet_loop',
        uuid: `${first.uuid}-quiet-loop`,
        timestamp: first.timestamp,
        content: tSync('summary.loop.quietChecks', { count: 1 }),
      }
      result.push(summary)
      streak = { objective: turn.objective, count: 1, message: summary }
    }
    index = turn.end
  }
  return result
}
