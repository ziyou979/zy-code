// Stub for src/tools/VerifyPlanExecutionTool/VerifyPlanExecutionTool.ts
import type { Tool } from '../../Tool.js'

export const VerifyPlanExecutionTool = {
  name: 'VerifyPlanExecution',
  isEnabled: () => false,
  isReadOnly: () => true,
  description: 'Verify plan execution',
  inputSchema: {},
} as unknown as Tool

// 插件化注册
import { toolRegistry } from '../registry.js'

toolRegistry.register(VerifyPlanExecutionTool)
