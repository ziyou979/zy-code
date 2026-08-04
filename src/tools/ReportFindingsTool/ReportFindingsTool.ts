import { z } from 'zod/v4'
import { tSync } from '../../i18n/index.js'
import { buildTool, type ToolDef } from '../tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { toolRegistry } from '../registry.js'
import { DESCRIPTION, PROMPT, REPORT_FINDINGS_TOOL_NAME } from './prompt.js'

const findingSchema = z.strictObject({
  file: z.string().describe('Repository-relative file path.'),
  line: z.number().int().positive().optional().describe('1-indexed line number.'),
  summary: z.string().describe('Concise explanation of the issue.'),
  short_summary: z.string().max(60).optional().describe('Short UI label, at most 60 characters.'),
  failure_scenario: z.string().describe('Concrete conditions and steps that expose the issue.'),
  category: z
    .string()
    .max(40)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .optional()
    .describe('Optional kebab-case category.'),
  verdict: z.enum(['CONFIRMED', 'PLAUSIBLE']).optional(),
  outcome: z.enum(['fixed', 'skipped', 'no_change_needed']).optional(),
})

const inputSchema = lazySchema(() =>
  z.strictObject({
    level: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
    findings: z.array(findingSchema).max(32),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    count: z.number().int().nonnegative(),
    level: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
    findings: z.array(findingSchema),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
type Output = z.infer<OutputSchema>

export const ReportFindingsTool = buildTool({
  name: REPORT_FINDINGS_TOOL_NAME,
  profile: 'headless',
  searchHint: 'submit verified structured code review issues',
  maxResultSizeChars: 256,
  strict: true,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PROMPT
  },
  userFacingName() {
    return tSync('reportFindings.name')
  },
  renderToolUseMessage() {
    return null
  },
  renderToolResultMessage() {
    return null
  },
  mapToolResultToToolResultBlock(output, toolUseID) {
    return {
      toolCallId: toolUseID,
      type: 'tool_result',
      content: output.count === 0 ? 'No findings reported.' : `${output.count} findings reported.`,
    }
  },
  async call(input) {
    return { data: { ...input, count: input.findings.length } }
  },
} satisfies ToolDef<InputSchema, Output>)

toolRegistry.register(ReportFindingsTool)
