// Stub for src/tools/TungstenTool/TungstenTool.ts
// Internal Anthropic-only tool — never active in external builds (USER_TYPE !== 'zy-super')

import { z } from 'zod'
import type { Tool } from '../../Tool.js'

export function clearSessionsWithTungstenUsage(): void {}
export function resetInitializationState(): void {}

export const TungstenTool: Tool = {
  inputSchema: z.object({}) as any,
  async call() {
    return { data: '' }
  },
  description() {
    return Promise.resolve('')
  },
  isConcurrencySafe: () => false,
  isEnabled: () => false,
  isReadOnly: () => true,
  toAutoClassifierInput: () => '',
  mapToolResultToToolResultBlockParam: (_content: unknown, toolUseID: string) => ({
    type: 'tool_result' as const,
    tool_use_id: toolUseID,
    content: [],
  }),
} as any
