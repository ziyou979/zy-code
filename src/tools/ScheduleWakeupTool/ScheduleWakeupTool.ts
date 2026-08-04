import { z } from 'zod/v4'
import { setScheduledTasksEnabled } from 'src/bootstrap/runtime/runtimeContext.js'
import { addCronTask, removeCronTasks } from '../../services/jobs/cronTasks.js'
import { buildTool, type ToolDef, type ValidationResult } from '../tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { toolRegistry } from '../registry.js'
import { DESCRIPTION, PROMPT, SCHEDULE_WAKEUP_TOOL_NAME } from './prompt.js'

const MIN_DELAY_SECONDS = 60
const MAX_DELAY_SECONDS = 3600

const inputSchema = lazySchema(() =>
  z.strictObject({
    delaySeconds: z
      .number()
      .optional()
      .describe('Delay before the next turn, from 60 to 3600 seconds.'),
    reason: z.string().optional().describe('Why this is the next useful wakeup time.'),
    prompt: z
      .string()
      .optional()
      .describe('The stable loop prompt, including <<autonomous-loop-dynamic>>.'),
    stop: z.boolean().optional().describe('Cancel the pending wakeup and end the dynamic loop.'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    scheduledFor: z.number().optional(),
    clampedDelaySeconds: z.number().optional(),
    wasClamped: z.boolean().optional(),
    stopped: z.boolean().optional(),
    cancelledWakeups: z.number().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
type Output = z.infer<OutputSchema>

function oneShotCron(timestamp: number): string {
  const date = new Date(timestamp)
  return `${date.getMinutes()} ${date.getHours()} ${date.getDate()} ${date.getMonth() + 1} *`
}

export const ScheduleWakeupTool = buildTool({
  name: SCHEDULE_WAKEUP_TOOL_NAME,
  profile: 'headless',
  searchHint: 're-arm or stop a self-paced autonomous loop',
  maxResultSizeChars: 512,
  shouldDefer: true,
  strict: true,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isConcurrencySafe() {
    return false
  },
  isReadOnly() {
    return false
  },
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PROMPT
  },
  async validateInput(input): Promise<ValidationResult> {
    if (input.stop) {
      return { result: true }
    }
    if (input.delaySeconds === undefined || !input.reason?.trim() || !input.prompt?.trim()) {
      return {
        result: false,
        message: 'delaySeconds, reason, and prompt are required unless stop=true.',
        errorCode: 1,
      }
    }
    if (!input.prompt.includes('<<autonomous-loop-dynamic>>')) {
      return {
        result: false,
        message: 'prompt must include <<autonomous-loop-dynamic>>.',
        errorCode: 2,
      }
    }
    return { result: true }
  },
  mapToolResultToToolResultBlock(output, toolUseID) {
    return {
      toolCallId: toolUseID,
      type: 'tool_result',
      content: output.stopped
        ? `Dynamic loop stopped; cancelled ${output.cancelledWakeups ?? 0} pending wakeup(s).`
        : `Next dynamic-loop wakeup scheduled for ${new Date(output.scheduledFor ?? 0).toISOString()}.`,
    }
  },
  renderToolUseMessage() {
    return null
  },
  renderToolResultMessage() {
    return null
  },
  async call(input, context) {
    const previous = context.getAppState().dynamicLoopWakeup
    if (previous) {
      await removeCronTasks([previous.id])
    }

    if (input.stop) {
      context.setAppState((state) => ({ ...state, dynamicLoopWakeup: undefined }))
      return { data: { stopped: true, cancelledWakeups: previous ? 1 : 0 } }
    }

    const requestedDelay = input.delaySeconds ?? MIN_DELAY_SECONDS
    const clampedDelaySeconds = Math.max(
      MIN_DELAY_SECONDS,
      Math.min(requestedDelay, MAX_DELAY_SECONDS),
    )
    // Cron 只能精确到分钟；向上对齐可避免比模型要求更早唤醒。
    const scheduledFor = Math.ceil((Date.now() + clampedDelaySeconds * 1000) / 60_000) * 60_000
    const prompt = input.prompt ?? ''
    const id = await addCronTask(oneShotCron(scheduledFor), prompt, false, false, context.agentId)
    context.setAppState((state) => ({
      ...state,
      dynamicLoopWakeup: { id, prompt, scheduledFor },
    }))
    setScheduledTasksEnabled(true)
    return {
      data: {
        scheduledFor,
        clampedDelaySeconds,
        wasClamped: clampedDelaySeconds !== requestedDelay,
      },
    }
  },
} satisfies ToolDef<InputSchema, Output>)

toolRegistry.register(ScheduleWakeupTool)
