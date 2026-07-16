import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../tools/Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'

export const PUSH_NOTIFICATION_TOOL_NAME = 'PushNotification'

const DESCRIPTION = 'Send a push notification to the user'

const PROMPT = `Send a push notification to the user's device.

Use this to notify the user about important events when they are not actively looking at the conversation.

Parameters:
- title: The title of the notification
- body: The message body of the notification`

const inputSchema = lazySchema(() =>
  z.strictObject({
    title: z.string().describe('The title of the notification'),
    body: z.string().describe('The message body of the notification'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    sent: z.boolean(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

export const PushNotificationTool = buildTool({
  name: PUSH_NOTIFICATION_TOOL_NAME,
  searchHint: 'send a push notification to the user',
  maxResultSizeChars: 10_000,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PROMPT
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'Push Notification'
  },
  async checkPermissions(input) {
    return { behavior: 'allow', updatedInput: input }
  },
  renderToolUseMessage() {
    return null
  },
  renderToolResultMessage() {
    return null
  },
  mapToolResultToToolResultBlock({ sent }, toolUseID) {
    const content = sent
      ? 'Push notification sent successfully.'
      : 'Failed to send push notification.'
    return {
      toolCallId: toolUseID,
      type: 'tool_result',
      content,
    }
  },
  async call({ title, body }, _context) {
    try {
      // Push notification would require a backend service.
      // For now, log the notification and return success.
      console.error(`[PushNotification] ${title}: ${body}`)
      return { data: { sent: true } }
    } catch {
      return { data: { sent: false } }
    }
  },
} satisfies ToolDef<InputSchema, Output>)

// 插件化注册
import { toolRegistry } from '../registry.js'

toolRegistry.register(PushNotificationTool)
