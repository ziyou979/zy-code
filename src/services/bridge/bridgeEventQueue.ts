import type { UUID } from 'node:crypto'
import { randomUUID } from 'node:crypto'
import { getIsNonInteractiveSession, getSessionId } from 'src/bootstrap/runtime/runtimeContext.js'
import type { WireWorkflowProgress } from '../../types/tools.js'

type TaskStartedEvent = {
  type: 'system'
  subtype: 'task_started'
  task_id: string
  tool_use_id?: string
  description: string
  task_type?: string
  workflow_name?: string
  prompt?: string
}

type TaskProgressEvent = {
  type: 'system'
  subtype: 'task_progress'
  task_id: string
  tool_use_id?: string
  description: string
  usage: {
    total_tokens: number
    tool_uses: number
    duration_ms: number
  }
  last_tool_name?: string
  summary?: string
  workflow_progress?: WireWorkflowProgress[]
}

type TaskNotificationWireEvent = {
  type: 'system'
  subtype: 'task_notification'
  task_id: string
  tool_use_id?: string
  status: 'completed' | 'failed' | 'stopped'
  output_file: string
  summary: string
  usage?: {
    total_tokens: number
    tool_uses: number
    duration_ms: number
  }
}

type SessionStateChangedEvent = {
  type: 'system'
  subtype: 'session_state_changed'
  state: 'idle' | 'running' | 'requires_action'
}

export type WireEvent =
  | TaskStartedEvent
  | TaskProgressEvent
  | TaskNotificationWireEvent
  | SessionStateChangedEvent

const MAX_QUEUE_SIZE = 1000
const queue: WireEvent[] = []

export function enqueueWireEvent(event: WireEvent): void {
  if (!getIsNonInteractiveSession()) {
    return
  }
  if (queue.length >= MAX_QUEUE_SIZE) {
    queue.shift()
  }
  queue.push(event)
}

export function drainWireEvents(): Array<WireEvent & { uuid: UUID; session_id: string }> {
  if (queue.length === 0) {
    return []
  }
  const events = queue.splice(0)
  return events.map((e) => ({
    ...e,
    uuid: randomUUID(),
    session_id: getSessionId(),
  }))
}

export function emitTaskTerminatedBridge(
  taskId: string,
  status: 'completed' | 'failed' | 'stopped',
  opts?: {
    toolUseId?: string
    summary?: string
    outputFile?: string
    usage?: { total_tokens: number; tool_uses: number; duration_ms: number }
  },
): void {
  enqueueWireEvent({
    type: 'system',
    subtype: 'task_notification',
    task_id: taskId,
    tool_use_id: opts?.toolUseId,
    status,
    output_file: opts?.outputFile ?? '',
    summary: opts?.summary ?? '',
    usage: opts?.usage,
  })
}
