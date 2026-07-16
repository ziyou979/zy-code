import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../tools/Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'

export const SUGGEST_BACKGROUND_PR_TOOL_NAME = 'SuggestBackgroundPR'

const DESCRIPTION = 'Suggest creating a pull request with the current changes'

const PROMPT = `Analyze the current changes and suggest a pull request.

Use this to review the current state of the working directory and propose a PR with a title and description.

Parameters:
- title: Suggested PR title
- description: Suggested PR body/description
- branch_name: Suggested branch name`

const inputSchema = lazySchema(() =>
  z.strictObject({
    title: z.string().describe('Suggested PR title'),
    description: z.string().describe('Suggested PR body/description'),
    branch_name: z.string().describe('Suggested branch name'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    title: z.string(),
    description: z.string(),
    branch_name: z.string(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

export const SuggestBackgroundPRTool = buildTool({
  name: SUGGEST_BACKGROUND_PR_TOOL_NAME,
  searchHint: 'suggest a pull request with current changes',
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
    return 'Suggest PR'
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
  mapToolResultToToolResultBlock({ title, branch_name }, toolUseID) {
    return {
      toolCallId: toolUseID,
      type: 'tool_result',
      content: `PR suggestion: "${title}" for branch "${branch_name}".`,
    }
  },
  async call({ title, description, branch_name }, _context) {
    return { data: { title, description, branch_name } }
  },
} satisfies ToolDef<InputSchema, Output>)

// 插件化注册
import { toolRegistry } from '../registry.js'

toolRegistry.register(SuggestBackgroundPRTool)
