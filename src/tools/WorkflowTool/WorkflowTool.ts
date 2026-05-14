import type { Tool } from '../../Tool.js'
import { z } from 'zod/v4'

export const WorkflowTool: Tool = {
  name: 'workflow',
  inputSchema: z.object({}).passthrough(),
  async call() {
    return { data: {} }
  },
  async description() {
    return 'Workflow tool'
  },
  isConcurrencySafe() {
    return true
  },
  isEnabled() {
    return true
  },
  isReadOnly() {
    return true
  },
  async checkPermissions() {
    return { behavior: 'allow' as const }
  },
  prompt() {
    return Promise.resolve('Workflow tool')
  },
  userFacingName() {
    return 'Workflow'
  },
  renderToolUseMessage() {
    return null
  },
  mapToolResultToToolResultBlock(content, toolUseID) {
    return {
      type: 'tool_result',
      toolCallId: toolUseID,
      content: [{ type: 'text', text: JSON.stringify(content) }],
    }
  },
  toAutoClassifierInput(input) {
    return input
  },
  maxResultSizeChars: 10000,
}

// 插件化注册
import { toolRegistry } from '../registry.js'
toolRegistry.register(WorkflowTool)
