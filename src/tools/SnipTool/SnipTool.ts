import { z } from 'zod/v4'
import React from 'react'
import { buildTool, type ToolDef } from '../../Tool.js'
import { isSnipRuntimeEnabled } from '../../services/compact/snipCompact.js'
import { SNIP_TOOL_NAME } from './prompt.js'
import { lazySchema } from '../../utils/lazySchema.js'

const inputSchema = lazySchema(() => z.strictObject({}))
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() => z.object({ tokensFreed: z.number() }))
type OutputSchema = ReturnType<typeof outputSchema>
type Output = z.infer<OutputSchema>

export const SnipTool = buildTool({
  name: SNIP_TOOL_NAME,
  searchHint: 'snip old conversation history to free context space',
  maxResultSizeChars: 500,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isEnabled() {
    return isSnipRuntimeEnabled()
  },
  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },
  async description() {
    return 'Snip (deterministically remove) old conversation history to reclaim context space.'
  },
  async prompt() {
    return 'Use this tool to snip old conversation messages and free context space.'
  },
  mapToolResultToToolResultBlock(output, toolUseID) {
    return {
      toolCallId: toolUseID,
      type: 'tool_result' as const,
      content: `Snipped ${output.tokensFreed} tokens.`,
    }
  },
  async call() {
    return { data: { tokensFreed: 0 } }
  },
  renderToolUseMessage() {
    return React.createElement(React.Fragment, null)
  },
} satisfies ToolDef<InputSchema, Output>)

// 插件化注册
import { toolRegistry } from '../registry.js'
toolRegistry.register(SnipTool)
