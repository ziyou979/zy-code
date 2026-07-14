// Stub for src/tools/TungstenTool/TungstenTool.ts
// Internal Anthropic-only tool — never active in external builds (USER_TYPE !== 'zy-super')

import { z } from 'zod'
import type { Tool } from '../../tool.js'

export function clearSessionsWithTungstenUsage(): void {}
export function resetInitializationState(): void {}

// biome-ignore lint/suspicious/noExplicitAny: 存根工具 — 外部构建永不激活
export const TungstenTool: Tool = {
  inputSchema: z.object({}),
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
  mapToolResultToToolResultBlock: (_content: unknown, toolUseID: string) => ({
    type: 'tool_result' as const,
    toolCallId: toolUseID,
    content: [],
  }),
} as unknown as Tool

// 插件化注册
import { toolRegistry } from '../registry.js'

toolRegistry.register(TungstenTool)
