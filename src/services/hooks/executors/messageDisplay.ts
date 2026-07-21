import { randomUUID } from 'node:crypto'
import type { MessageDisplayHookInput } from 'src/types/index.js'
import { getSessionId } from '../../../bootstrap/runtime/runtimeContext.js'
import type { ToolUseContext } from '../../../tools/tool.js'
import type { AssistantMessage } from '../../../types/message.js'
import { createDebugLog } from '../../../services/infra/debug.js'
import { extractTextContent } from '../../messages/predicates.js'
import { createBaseHookInput } from '../config.js'
import { executeHooks } from '../executeEngine.js'
import { hasHookForEvent } from '../matcher.js'

const hookLog = createDebugLog('hooks')

/**
 * MessageDisplay hook：渲染阶段最终拦截点。让 hook 改写显示文本（脱敏/折叠）或隐藏
 * 整条消息。**display-only**：只影响渲染，不改变对话上下文与转录（调用方把结果放进
 * message.displayOverride，渲染层读取，上下文构建仍用原 content）。
 *
 * 性能与安全：
 * - 每条消息渲染前都可能触发，故先 hasHookForEvent 快速短路（未配置时近零开销）。
 * - 强制短超时（500ms）+ fail-open：任何错误/超时都回退原文（不 transform、不 hide），
 *   绝不因 hook 故障而吞掉模型输出。
 *
 * 当前仅对 assistant 消息接线（最主要的脱敏目标）；message_role 枚举保留 user/system
 * 以便后续扩展。
 */
const MESSAGE_DISPLAY_TIMEOUT_MS = 500

export async function executeMessageDisplayHooks(
  message: AssistantMessage,
  toolUseContext: ToolUseContext,
): Promise<{ transformedText?: string; hide?: boolean }> {
  const appState = toolUseContext.getAppState()
  const sessionId = toolUseContext.agentId ?? getSessionId()
  if (!hasHookForEvent('MessageDisplay', appState, sessionId)) {
    return {}
  }

  const contentBlocks = Array.isArray(message.message.content) ? message.message.content : []
  const text = extractTextContent(contentBlocks, '\n')
  // 没有可显示文本（纯 tool_use 等）→ 不触发
  if (!text) {
    return {}
  }

  const hookInput: MessageDisplayHookInput = {
    ...createBaseHookInput(undefined, undefined, toolUseContext),
    hook_event_name: 'MessageDisplay',
    message_id: message.uuid,
    message_role: 'assistant',
    text,
  }

  const out: { transformedText?: string; hide?: boolean } = {}
  try {
    for await (const r of executeHooks({
      hookInput,
      toolUseID: randomUUID(),
      signal: toolUseContext.abortController?.signal,
      timeoutMs: MESSAGE_DISPLAY_TIMEOUT_MS,
      toolUseContext,
    })) {
      // 多个 hook：hide 取或、transformedText 后者覆盖。
      if (r.hide) {
        out.hide = true
      }
      if (r.transformedText !== undefined) {
        out.transformedText = r.transformedText
      }
    }
  } catch (err) {
    // fail-open：回退原文，避免 hook 故障吞掉/闪烁模型输出
    hookLog(`MessageDisplay hook failed; displaying original message: ${err}`)
    return {}
  }
  return out
}
