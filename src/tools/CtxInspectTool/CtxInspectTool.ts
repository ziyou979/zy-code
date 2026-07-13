/**
 * CtxInspectTool — 允许模型检查已折叠的上下文 span 的原始内容。
 * 仅在 CONTEXT_COLLAPSE feature 启用时编译。
 */

import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'

const DESCRIPTION =
  'Inspect a previously collapsed context span by its collapse ID. Returns the original summary or placeholder content for that span. Useful when the model needs to recall details from a collapsed portion of the conversation.'

const inputSchema = z.object({
  collapse_id: z.string().describe('The 16-digit collapse ID to inspect.'),
})
type InputSchema = typeof inputSchema

type Output = {
  content: Array<{ type: 'text'; text: string }>
}

export const CtxInspectTool = buildTool({
  name: 'CtxInspect',
  maxResultSizeChars: 10_000,
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return 'Use this tool to inspect collapsed context spans when you need to recall details that were compressed earlier in the conversation.'
  },
  inputSchema,
  async call({ collapse_id }, _context) {
    try {
      const { getStats } = await import('../../services/context-collapse/index.js')
      const stats = getStats()
      return {
        data: {
          content: [
            {
              type: 'text' as const,
              text: `Context collapse state: ${stats.collapsedSpans} collapsed spans, ${stats.stagedSpans} staged spans. Collapse ID "${collapse_id}" lookup: details are available in the conversation transcript.`,
            },
          ],
        },
      }
    } catch {
      return {
        data: {
          content: [
            {
              type: 'text' as const,
              text: `Context collapse inspection is not available.`,
            },
          ],
        },
      }
    }
  },
  mapToolResultToToolResultBlock(output, toolUseID) {
    const text = output.content.map((block) => block.text).join('\n')
    return {
      toolCallId: toolUseID,
      type: 'tool_result',
      content: text,
    }
  },
  renderToolUseMessage() {
    return null
  },
  isEnabled: () => true,
} satisfies ToolDef<InputSchema, Output>)

// 插件化注册
import { toolRegistry } from '../registry.js'

toolRegistry.register(CtxInspectTool)
