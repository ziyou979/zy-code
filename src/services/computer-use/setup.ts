import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildComputerUseTools } from '@ant/computer-use-mcp'
import { buildMcpToolName } from '../mcp/mcpStringUtils.js'
import type { ScopedMcpServerConfig } from '../mcp/types.js'

import { isInBundledMode } from '../../services/environment/bundledMode.js'
import { CLI_CU_CAPABILITIES, COMPUTER_USE_MCP_SERVER_NAME } from './common.js'
import { getChicagoCoordinateMode } from './gates.js'

/**
 * 构建动态 MCP 配置和允许的工具名称列表。对应 `setupClaudeInChrome` 的实现。
 * `mcp__computer-use__*` 工具被加入 `allowedTools`，从而绕过常规权限提示 ——
 * 包内的 `request_access` 会在整个会话中处理授权。
 *
 * MCP 层并非多余：API 后端检测到 `mcp__computer-use__*` 工具名时会在系统提示词中
 * 注入 computer use 可用性提示（anthropic 仓库中的 COMPUTER_USE_MCP_AVAILABILITY_HINT）。
 * 使用不同名称的内置工具不会触发该逻辑。Cowork 出于同样原因使用相同的名称
 * （apps/desktop/src/main/local-agent-mode/systemPrompt.ts:314）。
 */
export function setupComputerUseMCP(): {
  mcpConfig: Record<string, ScopedMcpServerConfig>
  allowedTools: string[]
} {
  const allowedTools = buildComputerUseTools(CLI_CU_CAPABILITIES, getChicagoCoordinateMode()).map(
    (t) => buildMcpToolName(COMPUTER_USE_MCP_SERVER_NAME, (t as unknown as { name: string }).name),
  )

  // command/args 永远不会被实际执行 —— client.ts 通过名称拦截并使用
  // 进程内服务器。配置只需以 type 'stdio' 存在即可命中正确分支。
  // 与 Chrome 的设置方式一致。
  const args = isInBundledMode()
    ? ['--computer-use-mcp']
    : [join(fileURLToPath(import.meta.url), '..', 'cli.js'), '--computer-use-mcp']

  return {
    mcpConfig: {
      [COMPUTER_USE_MCP_SERVER_NAME]: {
        type: 'stdio',
        command: process.execPath,
        args,
        scope: 'dynamic',
      } as const,
    },
    allowedTools,
  }
}
