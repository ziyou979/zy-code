import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { sleep } from '../../utils/sleep.js'
import { DESCRIPTION, SLEEP_TOOL_NAME } from './prompt.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    duration: z.number().describe('Duration to sleep in seconds (max 3600)'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    slept: z.number(),
    interrupted: z.boolean(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

export const SleepTool = buildTool({
  name: SLEEP_TOOL_NAME,
  searchHint: 'wait for a specified duration without holding a shell',
  maxResultSizeChars: 10_000,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return `Sleep for the specified duration. The user can interrupt at any time.`
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName() {
    return 'Sleep'
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
  mapToolResultToToolResultBlock({ slept, interrupted }, toolUseID) {
    const content = interrupted
      ? `Slept for ${slept}s before being interrupted.`
      : `Slept for ${slept}s successfully.`
    return {
      toolCallId: toolUseID,
      type: 'tool_result',
      content,
    }
  },
  async call({ duration }, context) {
    const clampedDuration = Math.min(Math.max(duration, 0), 3600)
    const ms = clampedDuration * 1000
    try {
      await sleep(ms, (context as any).signal)
      return { data: { slept: clampedDuration, interrupted: false } }
    } catch {
      return { data: { slept: clampedDuration, interrupted: true } }
    }
  },
} satisfies ToolDef<InputSchema, Output>)

// 插件化注册
import { toolRegistry } from '../registry.js'
toolRegistry.register(SleepTool)
