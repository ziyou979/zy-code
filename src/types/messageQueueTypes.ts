export type QueueOperation =
  | 'enqueue'
  | 'dequeue'
  | 'clear'
  | 'cancel'
  | 'reorder'

export interface QueueOperationMessage {
  type: 'queue-operation'
  operation: QueueOperation
  timestamp: string
  sessionId: string
  content?: string
}
