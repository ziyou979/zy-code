import type { HookEvent } from 'src/types/index.js'
import { callMCPTool } from '../../services/mcp/mcpToolCall.js'
import type { ToolUseContext } from '../../Tool.js'
import { createAttachmentMessage } from '../../utils/attachments.js'
import { errorMessage } from '../../utils/errors.js'
import type { McpToolHook } from '../../utils/settings/types.js'
import { jsonParse } from '../../utils/slowOperations.js'
import type { HookResult } from './types.js'

/**
 * 执行 mcp_tool 类型的 hook：不 spawn 子进程，直接调用一个已连接 MCP server 的工具。
 *
 * 参数构造：以 hook 事件 JSON 为基础参数，再合并 hook.args（静态参数优先）。工具的文本结果
 * 作为 additionalContext 注入模型上下文。server 未连接 / 调用失败 → 非阻塞错误（不打断回合）。
 */
export async function execMcpToolHook(
  hook: McpToolHook,
  hookName: string,
  hookEvent: HookEvent,
  jsonInput: string,
  signal: AbortSignal,
  toolUseContext: ToolUseContext,
  toolUseID: string | undefined,
): Promise<HookResult> {
  const id = toolUseID ?? ''

  const failure = (stderr: string): HookResult => ({
    hook,
    outcome: 'non_blocking_error',
    message: createAttachmentMessage({
      type: 'hook_non_blocking_error',
      hookName,
      toolUseID: id,
      hookEvent,
      stderr,
      stdout: '',
      exitCode: 1,
      // biome-ignore lint/suspicious/noExplicitAny: 钩子系统动态类型处理
    }) as any,
  })

  const conn = toolUseContext.getAppState().mcp.clients.find((c) => c.name === hook.server)
  if (!conn || conn.type !== 'connected') {
    return failure(`MCP server "${hook.server}" is not connected`)
  }

  // 基础参数 = 事件 JSON；hook.args 覆盖其上（静态参数优先）。
  let baseArgs: Record<string, unknown> = {}
  try {
    const parsed = jsonParse(jsonInput)
    if (parsed && typeof parsed === 'object') {
      baseArgs = parsed as Record<string, unknown>
    }
  } catch {
    // jsonInput 解析失败时退化为只用 hook.args
  }
  const args = { ...baseArgs, ...(hook.args ?? {}) }

  try {
    const result = await callMCPTool({
      client: conn,
      tool: hook.tool,
      args,
      signal,
    })
    const content = result.content
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content
              .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
              .map((b) => b.text)
              .join('\n')
          : ''

    return {
      hook,
      outcome: 'success',
      additionalContext: text || undefined,
      message: createAttachmentMessage({
        type: 'hook_success',
        hookName,
        toolUseID: id,
        hookEvent,
        content: '',
        // biome-ignore lint/suspicious/noExplicitAny: 钩子系统动态类型处理
      }) as any,
    }
  } catch (error) {
    return failure(`MCP tool "${hook.server}/${hook.tool}" call failed: ${errorMessage(error)}`)
  }
}
