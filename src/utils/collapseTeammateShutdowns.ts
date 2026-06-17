import type { AttachmentMessage, RenderableMessage } from '../types/message.js'
import type { Attachment } from './attachments.js'

function isTeammateShutdownAttachment(msg: RenderableMessage): msg is AttachmentMessage {
  if (msg.type !== 'attachment') {
    return false
  }
  const att = msg.attachment as Attachment
  return (
    att.type === 'task_status' &&
    att.taskType === 'in_process_teammate' &&
    att.status === 'completed'
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
          } as unknown as AttachmentMessage['attachment'],
        })
      }
    } else {
      result.push(msg)
      i++
    }
  }

  return result
}
