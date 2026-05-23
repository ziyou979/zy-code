import type { AttachmentMessage, RenderableMessage } from '../types/message.js'

function isTeammateShutdownAttachment(msg: RenderableMessage): msg is AttachmentMessage {
  return (
    msg.type === 'attachment' &&
    (msg.attachment as any).type === 'task_status' &&
    (msg.attachment as any).taskType === 'in_process_teammate' &&
    (msg.attachment as any).status === 'completed'
  )
}

/**
 * Collapses consecutive in-process teammate shutdown task_status attachments
 * into a single `teammate_shutdown_batch` attachment with a count.
 */
export function collapseTeammateShutdowns(messages: RenderableMessage[]): RenderableMessage[] {
  const result: RenderableMessage[] = []
  let i = 0

  while (i < messages.length) {
    const msg = messages[i]!
    if (isTeammateShutdownAttachment(msg)) {
      let count = 0
      while (i < messages.length && isTeammateShutdownAttachment(messages[i]!)) {
        count++
        i++
      }
      if (count === 1) {
        result.push(msg)
      } else {
        result.push({
          type: 'attachment',
          uuid: msg.uuid,
          timestamp: msg.timestamp,
          attachment: {
            type: 'teammate_shutdown_batch',
            count,
          } as any,
        })
      }
    } else {
      result.push(msg)
      i++
    }
  }

  return result
}
