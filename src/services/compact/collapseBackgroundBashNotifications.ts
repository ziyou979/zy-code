import { STATUS_TAG, SUMMARY_TAG, TASK_NOTIFICATION_TAG } from '../../constants/xml.js'
import { BACKGROUND_BASH_SUMMARY_PREFIX } from '../../tasks/local-shell-task/LocalShellTask.js'
import type { RenderableMessage, UserMessage } from '../../types/message.js'
import { tSync } from '../../i18n/index.js'
import { isFullscreenEnvEnabled } from '../terminal/fullscreen.js'
import { extractTag } from '../messages/predicates.js'

function isCompletedBackgroundBash(msg: RenderableMessage): msg is UserMessage {
  if (msg.type !== 'user') {
    return false
  }
  const content = msg.message.content[0]
  if (!content || content.type !== 'text') {
    return false
  }
  if (!content.text.includes(`<${TASK_NOTIFICATION_TAG}`)) {
    return false
  }
  // 仅折叠成功完成的任务；失败或被终止的任务仍逐条显示。
  if (extractTag(content.text, STATUS_TAG) !== 'completed') {
    return false
  }
  // 通过前缀常量区分 bash 类型的 LocalShellTask 完成通知与
  // agent/workflow/monitor 通知。monitor 完成通知有自己的摘要文案，
  // 此处有意不折叠。
  return extractTag(content.text, SUMMARY_TAG)?.startsWith(BACKGROUND_BASH_SUMMARY_PREFIX) ?? false
}

/**
 * 将连续的后台 bash 完成通知折叠为一条合成的
 * “N background commands completed”通知。失败或被终止的任务以及
 * agent/workflow 通知保持不变。monitor 流事件（enqueueStreamEvent）
 * 不含 <status> 标签，因此不会命中。
 *
 * verbose 模式下原样返回，确保 ctrl+O 能显示每条完成通知。
 */
export function collapseBackgroundBashNotifications(
  messages: RenderableMessage[],
  verbose: boolean,
): RenderableMessage[] {
  if (!isFullscreenEnvEnabled()) {
    return messages
  }
  if (verbose) {
    return messages
  }

  const result: RenderableMessage[] = []
  let i = 0

  while (i < messages.length) {
    const msg = messages[i]!
    if (isCompletedBackgroundBash(msg)) {
      let count = 0
      while (i < messages.length && isCompletedBackgroundBash(messages[i]!)) {
        count++
        i++
      }
      if (count === 1) {
        result.push(msg)
      } else {
        // 合成 UserAgentNotificationMessage 已支持渲染的任务通知，
        // 无需新增 renderer。
        result.push({
          ...msg,
          message: {
            role: 'user',
            content: [
              {
                type: 'text',
                text: `<${TASK_NOTIFICATION_TAG}><${STATUS_TAG}>completed</${STATUS_TAG}><${SUMMARY_TAG}>${tSync('summary.backgroundCommands.completed', { count })}</${SUMMARY_TAG}></${TASK_NOTIFICATION_TAG}>`,
              },
            ],
          },
        })
      }
    } else {
      result.push(msg)
      i++
    }
  }

  return result
}
