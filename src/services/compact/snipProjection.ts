/**
 * Snip projection — identifies snip boundary messages in the conversation
 * and projects a snipped view of the message list.
 */

export function isSnipBoundaryMessage(message: { type: string; subtype?: string }): boolean {
  return message.type === 'system' && message.subtype === 'snip_boundary'
}

export function projectSnippedView(messages: unknown[]): unknown[] {
  return messages
}
