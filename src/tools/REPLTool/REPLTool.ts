import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { REPL_TOOL_NAME } from './constants.js'

export const DESCRIPTION = 'Execute multiple commands in a single batch'

export const PROMPT = `Execute multiple commands in a batch. This is more efficient than calling tools individually.

Use this for batch operations like reading multiple files, running multiple shell commands, or combining file operations.

You can use the following sub-commands:
- read <path> — Read a file
- edit <path> — Edit a file (followed by content)
- write <path> — Write a file (followed by content)
- bash <command> — Run a shell command
- glob <pattern> — Search for files by pattern
- grep <pattern> <path> — Search file contents

Separate commands with newlines.`

const inputSchema = lazySchema(() =>
  z.strictObject({
    commands: z.string().describe('Batch of commands to execute, one per line'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    output: z.string().describe('Combined output of all commands'),
    success: z.boolean(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

export type Output = z.infer<OutputSchema>

export const REPLTool = buildTool({
  name: REPL_TOOL_NAME,
  searchHint: 'execute batch commands',
  maxResultSizeChars: 100_000,
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
    return ''
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
  mapToolResultToToolResultBlock({ output, success }, toolUseID) {
    return {
      toolCallId: toolUseID,
      type: 'tool_result',
      content: success ? output : `Error executing REPL: ${output}`,
    }
  },
  async call({ commands }, context) {
    try {
      const { exec } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const execAsync = promisify(exec)

      const cwd = (context as any).cwd || process.cwd()
      const { stdout, stderr } = await execAsync(commands, {
        cwd,
        maxBuffer: 10 * 1024 * 1024,
      })

      const output = stderr ? `${stdout}\n[stderr] ${stderr}` : stdout
      return { data: { output: output.trim(), success: true } }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { data: { output: message, success: false } }
    }
  },
} satisfies ToolDef<InputSchema, Output>)

// 插件化注册
import { toolRegistry } from '../registry.js'
toolRegistry.register(REPLTool)
