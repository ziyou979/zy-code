import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'

export const SUBSCRIBE_PR_TOOL_NAME = 'SubscribePR'

const DESCRIPTION = 'Subscribe to a GitHub Pull Request for notifications'

const PROMPT = `Subscribe to a GitHub Pull Request to receive notifications about updates.

Use this to monitor a PR and get notified when there are new comments, commits, or status changes.

Parameters:
- pr_url: The URL of the GitHub Pull Request to subscribe to`

const inputSchema = lazySchema(() =>
  z.strictObject({
    pr_url: z.string().url().describe('The URL of the GitHub Pull Request to subscribe to'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    subscribed: z.boolean(),
    pr_url: z.string(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

export const SubscribePRTool = buildTool({
  name: SUBSCRIBE_PR_TOOL_NAME,
  searchHint: 'subscribe to a GitHub PR for notifications',
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
    return 'Subscribe PR'
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
  mapToolResultToToolResultBlock({ subscribed, pr_url }, toolUseID) {
    const content = subscribed
      ? `Successfully subscribed to PR: ${pr_url}`
      : `Failed to subscribe to PR: ${pr_url}`
    return {
      toolCallId: toolUseID,
      type: 'tool_result',
      content,
    }
  },
  async call({ pr_url }, context) {
    try {
      // Store subscription in app state
      const appState = context.getAppState()
      const existingSubscriptions =
        ((appState as Record<string, unknown>).prSubscriptions as string[] | undefined) ?? []
      if (!existingSubscriptions.includes(pr_url)) {
        context.setAppState((prev) => ({
          ...prev,
          prSubscriptions: [...existingSubscriptions, pr_url],
        } as typeof prev))
      }
      return { data: { subscribed: true, pr_url } }
    } catch {
      return { data: { subscribed: false, pr_url } }
    }
  },
} satisfies ToolDef<InputSchema, Output>)

// 插件化注册
import { toolRegistry } from '../registry.js'

toolRegistry.register(SubscribePRTool)
