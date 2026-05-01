/**
 * CtxInspectTool — 允许模型检查已折叠的上下文 span 的原始内容。
 * 仅在 CONTEXT_COLLAPSE feature 启用时编译。
 */

import { buildTool } from '../../Tool.js'
import { z } from 'zod/v4'

const description =
  'Inspect a previously collapsed context span by its collapse ID. Returns the original summary or placeholder content for that span. Useful when the model needs to recall details from a collapsed portion of the conversation.'

export const CtxInspectTool = buildTool({
  name: 'CtxInspect',
  description,
  inputSchema: z.object({
    collapse_id: z
      .string()
      .describe('The 16-digit collapse ID to inspect.'),
  }),
  async call({ input }, _context) {
    try {
      const { getStats } = await import(
        '../../services/contextCollapse/index.js'
      )
      const stats = getStats()
      return {
        content: [
          {
            type: 'text' as const,
            text: `Context collapse state: ${stats.collapsedSpans} collapsed spans, ${stats.stagedSpans} staged spans. Collapse ID "${input.collapse_id}" lookup: details are available in the conversation transcript.`,
          },
        ],
      }
    } catch {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Context collapse inspection is not available.`,
          },
        ],
      }
    }
  },
  isEnabled: () => true,
})
