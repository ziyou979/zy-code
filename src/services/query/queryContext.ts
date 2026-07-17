/**
 * 构建 API 缓存键前缀（systemPrompt、userContext、systemContext）
 * 供 query() 调用使用的共享辅助函数。
 *
 * 独立为单独文件，因为它从 context.ts 和 constants/prompts.ts 导入，
 * 这些模块在依赖图中层级较高。将这些导入放在 systemPrompt.ts 或
 * sideQuestion.ts（两者均可从 commands.ts 访问）中会产生循环依赖。
 * 仅入口层文件从此处导入（QueryEngine.ts、cli/print.ts）。
 */

import { getMainLoopModel } from 'src/services/model/model.js'
import type { Command } from '../../commands/index.js'
import { getSystemPrompt } from '../../constants/prompts.js'
import { getSystemContext, getUserContext } from '../context/context.js'
import type { MCPServerConnection } from '../mcp/types.js'
import type { AppState } from '../../state/AppStateStore.js'
import type { Tools, ToolUseContext } from '../../tools/tool.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import type { Message } from '../../types/message.js'
import { createAbortController } from '../../utils/abortController.js'
import type { FileStateCache } from '../../utils/fileStateCache.js'
import type { CacheSafeParams } from '../../utils/forkedAgent.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'
import { shouldEnableThinkingByDefault, type ThinkingConfig } from '../../utils/thinking.js'

/**
 * 获取构成 API 缓存键前缀的三个上下文部分：
 * systemPrompt 片段、userContext、systemContext。
 *
 * 当设置了 customSystemPrompt 时，将跳过默认的 getSystemPrompt 构建和
 * getSystemContext — 自定义提示词完全替代默认提示词，而 systemContext
 * 会被追加到一个未使用的默认值上。
 *
 * 调用者从 defaultSystemPrompt（或 customSystemPrompt）+ 可选附加内容 +
 * appendSystemPrompt 组装最终的 systemPrompt。QueryEngine 在此基础上
 * 注入协调器 userContext 和记忆机制提示词；sideQuestion 的回退方案直接
 * 使用基础结果。
 */
export async function fetchSystemPromptParts({
  tools,
  mainLoopModel,
  additionalWorkingDirectories,
  mcpClients,
  customSystemPrompt,
}: {
  tools: Tools
  mainLoopModel: string
  additionalWorkingDirectories: string[]
  mcpClients: MCPServerConnection[]
  customSystemPrompt: string | undefined
}): Promise<{
  defaultSystemPrompt: string[]
  userContext: { [k: string]: string }
  systemContext: { [k: string]: string }
}> {
  const [defaultSystemPrompt, userContext, systemContext] = await Promise.all([
    customSystemPrompt !== undefined
      ? Promise.resolve([])
      : getSystemPrompt(tools, mainLoopModel, additionalWorkingDirectories, mcpClients),
    getUserContext(),
    customSystemPrompt !== undefined ? Promise.resolve({}) : getSystemContext(),
  ])
  return { defaultSystemPrompt, userContext, systemContext }
}

/**
 * 当 getLastCacheSafeParams() 为 null 时，从原始输入构建 CacheSafeParams。
 *
 * 供 SDK side_question 处理器（print.ts）在恢复时、轮次完成之前使用 —
 * 此时尚无 stopHooks 快照。镜像 QueryEngine.ts:ask() 中的系统提示词
 * 组装逻辑，使重建的前缀与主循环将发送的内容匹配，在常见情况下保留
 * 缓存命中。
 *
 * 如果主循环应用了此路径不知晓的附加内容（协调器模式、记忆机制提示词），
 * 可能仍会缓存未命中。这是可接受的 — 替代方案是返回 null 并使
 * side question 完全失败。
 */
export async function buildSideQuestionFallbackParams({
  tools,
  commands,
  mcpClients,
  messages,
  readFileState,
  getAppState,
  setAppState,
  customSystemPrompt,
  appendSystemPrompt,
  thinkingConfig,
  agents,
}: {
  tools: Tools
  commands: Command[]
  mcpClients: MCPServerConnection[]
  messages: Message[]
  readFileState: FileStateCache
  getAppState: () => AppState
  setAppState: (f: (prev: AppState) => AppState) => void
  customSystemPrompt: string | undefined
  appendSystemPrompt: string | undefined
  thinkingConfig: ThinkingConfig | undefined
  agents: AgentDefinition[]
}): Promise<CacheSafeParams> {
  const mainLoopModel = getMainLoopModel()!
  const appState = getAppState()

  const { defaultSystemPrompt, userContext, systemContext } = await fetchSystemPromptParts({
    tools,
    mainLoopModel,
    additionalWorkingDirectories: Array.from(
      appState.toolPermissionContext.additionalWorkingDirectories.keys(),
    ),
    mcpClients,
    customSystemPrompt,
  })

  const systemPrompt = asSystemPrompt([
    ...(customSystemPrompt !== undefined ? [customSystemPrompt] : defaultSystemPrompt),
    ...(appendSystemPrompt ? [appendSystemPrompt] : []),
  ])

  // 剥离进行中的 assistant 消息（stopReason === null）— 与 btw.tsx 中相同的
  // 保护逻辑。SDK 可能在轮次中途触发 side_question。
  const last = messages.at(-1)
  const forkContextMessages =
    last?.type === 'assistant' && last.message.stopReason === null
      ? messages.slice(0, -1)
      : messages

  const toolUseContext: ToolUseContext = {
    options: {
      commands,
      debug: false,
      mainLoopModel,
      tools,
      verbose: false,
      thinkingConfig:
        thinkingConfig ??
        (shouldEnableThinkingByDefault(mainLoopModel) !== false
          ? { type: 'adaptive' }
          : { type: 'disabled' }),
      mcpClients,
      mcpResources: {},
      isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: agents, allAgents: [] },
      customSystemPrompt,
      appendSystemPrompt,
    },
    abortController: createAbortController(),
    readFileState,
    getAppState,
    setAppState,
    messages: forkContextMessages,
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
  }

  return {
    systemPrompt,
    userContext,
    systemContext,
    toolUseContext,
    forkContextMessages,
  }
}
