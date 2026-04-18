import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'

export const SEND_USER_FILE_TOOL_NAME = 'SendUserFile'

const DESCRIPTION = 'Send a file to the user'

const PROMPT = `Send a file or document to the user. This tool creates a file and delivers it to the user.

Use this when you need to provide the user with a generated file, report, or document.

Parameters:
- file_name: The name of the file to send (include extension)
- content: The content of the file`

const inputSchema = lazySchema(() =>
  z.strictObject({
    file_name: z
      .string()
      .describe('The name of the file to send (include extension)'),
    content: z.string().describe('The content of the file'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    file_name: z.string(),
    success: z.boolean(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

export const SendUserFileTool = buildTool({
  name: SEND_USER_FILE_TOOL_NAME,
  searchHint: 'send a file to the user',
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
    return 'Send User File'
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
  mapToolResultToToolResultBlockParam({ file_name, success }, toolUseID) {
    const content = success
      ? `File "${file_name}" sent to user successfully.`
      : `Failed to send file "${file_name}".`
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content,
    }
  },
  async call({ file_name, content }, context) {
    try {
      const fs = await import('node:fs/promises')
      const path = await import('node:path')
      const cwd = (context as any).cwd || process.cwd()
      const filePath = path.join(cwd, file_name)
      await fs.writeFile(filePath, content, 'utf-8')
      return { data: { file_name, success: true } }
    } catch {
      return { data: { file_name, success: false } }
    }
  },
} satisfies ToolDef<InputSchema, Output>)
