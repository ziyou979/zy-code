import { feature } from 'bun:bundle'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../analytics/index.js'
import type { ToolUseContext } from '../../tools/tool.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import { isBuiltInAgent } from '../../tools/AgentTool/loadAgentsDir.js'
import { isEnvTruthy, isInternalBuild } from '../../services/infra/envUtils.js'
import { asSystemPrompt, type SystemPrompt } from '../api/systemPromptType.js'

export { asSystemPrompt, type SystemPrompt } from '../api/systemPromptType.js'

// 死代码消除：proactive 模式的条件导入。
// 与 prompts.ts 相同的模式——延迟 require 以避免将该模块
// 拉入非 proactive 构建中。
/* eslint-disable @typescript-eslint/no-require-imports */
const proactiveModule =
  feature('PROACTIVE') || feature('KAIROS')
    ? (require('../../proactive/index.js') as typeof import('../../proactive/index.js'))
    : null
/* eslint-enable @typescript-eslint/no-require-imports */

function isProactiveActive_SAFE_TO_CALL_ANYWHERE(): boolean {
  return proactiveModule?.isProactiveActive() ?? false
}

/**
 * 基于优先级构建有效的 system prompt 数组：
 * 0. 覆盖 system prompt（如果设置，例如通过 loop 模式——替换所有其他 prompt）
 * 1. Coordinator system prompt（如果 coordinator 模式激活）
 * 2. Agent system prompt（如果设置了 mainThreadAgentDefinition）
 *    - 在 proactive 模式下：agent prompt 附加到默认 prompt 之后（agent 在自主
 *      agent prompt 之上添加领域指令，与 teammate 模式相同）
 *    - 其他情况：agent prompt 替换默认 prompt
 * 3. 自定义 system prompt（如果通过 --system-prompt 指定）
 * 4. 默认 system prompt（标准 ZY Code prompt）
 *
 * 此外，appendSystemPrompt 始终添加在末尾（override 设置时除外）。
 */
export function buildEffectiveSystemPrompt({
  mainThreadAgentDefinition,
  toolUseContext,
  customSystemPrompt,
  defaultSystemPrompt,
  appendSystemPrompt,
  overrideSystemPrompt,
}: {
  mainThreadAgentDefinition: AgentDefinition | undefined
  toolUseContext: Pick<ToolUseContext, 'options'>
  customSystemPrompt: string | undefined
  defaultSystemPrompt: string[]
  appendSystemPrompt: string | undefined
  overrideSystemPrompt?: string | null
}): SystemPrompt {
  if (overrideSystemPrompt) {
    return asSystemPrompt([overrideSystemPrompt])
  }
  // Coordinator 模式：使用 coordinator prompt 而非默认 prompt
  // 使用内联环境变量检查而非 coordinatorModule 以避免
  // 测试模块加载时的循环依赖问题。
  if (
    feature('COORDINATOR_MODE') &&
    isEnvTruthy(process.env.ZY_CODE_COORDINATOR_MODE) &&
    !mainThreadAgentDefinition
  ) {
    // 延迟 require 以避免模块加载时的循环依赖
    const { getCoordinatorSystemPrompt } =
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('../../coordinator/coordinatorMode.js') as typeof import('../../coordinator/coordinatorMode.js')
    return asSystemPrompt([
      getCoordinatorSystemPrompt(),
      ...(appendSystemPrompt ? [appendSystemPrompt] : []),
    ])
  }

  const agentSystemPrompt = mainThreadAgentDefinition
    ? isBuiltInAgent(mainThreadAgentDefinition)
      ? mainThreadAgentDefinition.getSystemPrompt({
          toolUseContext: { options: toolUseContext.options },
        })
      : mainThreadAgentDefinition.getSystemPrompt()
    : undefined

  // 为主循环 agent 记录 agent memory 加载事件
  if (mainThreadAgentDefinition?.memory) {
    logEvent('zy_agent_memory_loaded', {
      ...(isInternalBuild() && {
        agent_type:
          mainThreadAgentDefinition.agentType as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      }),
      scope:
        mainThreadAgentDefinition.memory as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      source: 'main-thread' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
  }

  // 在 proactive 模式下，agent 指令附加到默认 prompt 之后
  // 而非替换它。proactive 默认 prompt 已经很精简
  //（自主 agent 身份 + memory + env + proactive 部分），agent
  // 在此基础上添加领域特定行为——与 teammate 模式相同。
  if (
    agentSystemPrompt &&
    (feature('PROACTIVE') || feature('KAIROS')) &&
    isProactiveActive_SAFE_TO_CALL_ANYWHERE()
  ) {
    return asSystemPrompt([
      ...defaultSystemPrompt,
      `\n# Custom Agent Instructions\n${agentSystemPrompt}`,
      ...(appendSystemPrompt ? [appendSystemPrompt] : []),
    ])
  }

  return asSystemPrompt([
    ...(agentSystemPrompt
      ? [agentSystemPrompt]
      : customSystemPrompt
        ? [customSystemPrompt]
        : defaultSystemPrompt),
    ...(appendSystemPrompt ? [appendSystemPrompt] : []),
  ])
}
