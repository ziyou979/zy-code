// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { toolMatchesName, type Tool, type Tools } from './Tool.js'
import { AgentTool } from './tools/AgentTool/AgentTool.js'
import { SkillTool } from './tools/SkillTool/SkillTool.js'
import { BashTool } from './tools/BashTool/BashTool.js'
import { FileEditTool } from './tools/FileEditTool/FileEditTool.js'
import { FileReadTool } from './tools/FileReadTool/FileReadTool.js'
import { FileWriteTool } from './tools/FileWriteTool/FileWriteTool.js'
import { GlobTool } from './tools/GlobTool/GlobTool.js'
import { NotebookEditTool } from './tools/NotebookEditTool/NotebookEditTool.js'
import { WebFetchTool } from './tools/WebFetchTool/WebFetchTool.js'
import { TaskStopTool } from './tools/TaskStopTool/TaskStopTool.js'
import { BriefTool } from './tools/BriefTool/BriefTool.js'
import { isEnvTruthy, isInternalBuild } from './utils/envUtils.js'

// 死代码消除：仅 Ant 内部工具的条件导入
/* eslint-disable custom-rules/no-process-env-top-level, @typescript-eslint/no-require-imports */
const REPLTool = isInternalBuild() ? require('./tools/REPLTool/REPLTool.js').REPLTool : null
const SuggestBackgroundPRTool = isInternalBuild()
  ? require('./tools/SuggestBackgroundPRTool/SuggestBackgroundPRTool.js').SuggestBackgroundPRTool
  : null
const SleepTool =
  feature('PROACTIVE') || feature('KAIROS')
    ? require('./tools/SleepTool/SleepTool.js').SleepTool
    : null
const cronTools = feature('AGENT_TRIGGERS')
  ? [
      require('./tools/ScheduleCronTool/CronCreateTool.js').CronCreateTool,
      require('./tools/ScheduleCronTool/CronDeleteTool.js').CronDeleteTool,
      require('./tools/ScheduleCronTool/CronListTool.js').CronListTool,
    ]
  : []
const RemoteTriggerTool = feature('AGENT_TRIGGERS_REMOTE')
  ? require('./tools/RemoteTriggerTool/RemoteTriggerTool.js').RemoteTriggerTool
  : null
const MonitorTool = feature('MONITOR_TOOL')
  ? require('./tools/MonitorTool/MonitorTool.js').MonitorTool
  : null
const SendUserFileTool = feature('KAIROS')
  ? require('./tools/SendUserFileTool/SendUserFileTool.js').SendUserFileTool
  : null
const PushNotificationTool =
  feature('KAIROS') || feature('KAIROS_PUSH_NOTIFICATION')
    ? require('./tools/PushNotificationTool/PushNotificationTool.js').PushNotificationTool
    : null
const SubscribePRTool = feature('KAIROS_GITHUB_WEBHOOKS')
  ? require('./tools/SubscribePRTool/SubscribePRTool.js').SubscribePRTool
  : null
/* eslint-enable custom-rules/no-process-env-top-level, @typescript-eslint/no-require-imports */
import { TaskOutputTool } from './tools/TaskOutputTool/TaskOutputTool.js'
import { WebSearchTool } from './tools/WebSearchTool/WebSearchTool.js'
import { TodoWriteTool } from './tools/TodoWriteTool/TodoWriteTool.js'
import { ExitPlanModeV2Tool } from './tools/ExitPlanModeTool/ExitPlanModeV2Tool.js'
import { TestingPermissionTool } from './tools/testing/TestingPermissionTool.js'
import { GrepTool } from './tools/GrepTool/GrepTool.js'
import { TungstenTool } from './tools/TungstenTool/TungstenTool.js'
// 延迟 require 以打破循环依赖：tools.ts -> TeamCreateTool/TeamDeleteTool -> ... -> tools.ts
/* eslint-disable @typescript-eslint/no-require-imports */
const getTeamCreateTool = () =>
  require('./tools/TeamCreateTool/TeamCreateTool.js')
    .TeamCreateTool as typeof import('./tools/TeamCreateTool/TeamCreateTool.js').TeamCreateTool
const getTeamDeleteTool = () =>
  require('./tools/TeamDeleteTool/TeamDeleteTool.js')
    .TeamDeleteTool as typeof import('./tools/TeamDeleteTool/TeamDeleteTool.js').TeamDeleteTool
const getSendMessageTool = () =>
  require('./tools/SendMessageTool/SendMessageTool.js')
    .SendMessageTool as typeof import('./tools/SendMessageTool/SendMessageTool.js').SendMessageTool
/* eslint-enable @typescript-eslint/no-require-imports */
import { AskUserQuestionTool } from './tools/AskUserQuestionTool/AskUserQuestionTool.js'
import { LSPTool } from './tools/LSPTool/LSPTool.js'
import { ListMcpResourcesTool } from './tools/ListMcpResourcesTool/ListMcpResourcesTool.js'
import { ReadMcpResourceTool } from './tools/ReadMcpResourceTool/ReadMcpResourceTool.js'
import { ToolSearchTool } from './tools/ToolSearchTool/ToolSearchTool.js'
import { EnterPlanModeTool } from './tools/EnterPlanModeTool/EnterPlanModeTool.js'
import { EnterWorktreeTool } from './tools/EnterWorktreeTool/EnterWorktreeTool.js'
import { ExitWorktreeTool } from './tools/ExitWorktreeTool/ExitWorktreeTool.js'
import { ConfigTool } from './tools/ConfigTool/ConfigTool.js'
import { TaskCreateTool } from './tools/TaskCreateTool/TaskCreateTool.js'
import { TaskGetTool } from './tools/TaskGetTool/TaskGetTool.js'
import { TaskUpdateTool } from './tools/TaskUpdateTool/TaskUpdateTool.js'
import { TaskListTool } from './tools/TaskListTool/TaskListTool.js'
import uniqBy from 'lodash-es/uniqBy.js'
import { isToolSearchEnabledOptimistic } from './utils/toolSearch.js'
import { isTodoV2Enabled } from './utils/tasks.js'
// 死代码消除：ZY_CODE_VERIFY_PLAN 的条件导入
/* eslint-disable custom-rules/no-process-env-top-level, @typescript-eslint/no-require-imports */
const VerifyPlanExecutionTool =
  process.env.ZY_CODE_VERIFY_PLAN === 'true'
    ? require('./tools/VerifyPlanExecutionTool/VerifyPlanExecutionTool.js').VerifyPlanExecutionTool
    : null
/* eslint-enable custom-rules/no-process-env-top-level, @typescript-eslint/no-require-imports */
import { SYNTHETIC_OUTPUT_TOOL_NAME } from './tools/SyntheticOutputTool/SyntheticOutputTool.js'
export {
  ALL_AGENT_DISALLOWED_TOOLS,
  CUSTOM_AGENT_DISALLOWED_TOOLS,
  ASYNC_AGENT_ALLOWED_TOOLS,
  COORDINATOR_MODE_ALLOWED_TOOLS,
} from './constants/tools.js'
import { feature } from 'bun:bundle'
// 死代码消除：OVERFLOW_TEST_TOOL 的条件导入
/* eslint-disable custom-rules/no-process-env-top-level, @typescript-eslint/no-require-imports */
const OverflowTestTool = feature('OVERFLOW_TEST_TOOL')
  ? require('./tools/OverflowTestTool/OverflowTestTool.js').OverflowTestTool
  : null
const CtxInspectTool = feature('CONTEXT_COLLAPSE')
  ? require('./tools/CtxInspectTool/CtxInspectTool.js').CtxInspectTool
  : null
const TerminalCaptureTool = feature('TERMINAL_PANEL')
  ? require('./tools/TerminalCaptureTool/TerminalCaptureTool.js').TerminalCaptureTool
  : null
const WebBrowserTool = feature('WEB_BROWSER_TOOL')
  ? require('./tools/WebBrowserTool/WebBrowserTool.js').WebBrowserTool
  : null
const coordinatorModeModule = feature('COORDINATOR_MODE')
  ? (require('./coordinator/coordinatorMode.js') as typeof import('./coordinator/coordinatorMode.js'))
  : null
const SnipTool = feature('HISTORY_SNIP') ? require('./tools/SnipTool/SnipTool.js').SnipTool : null
const ListPeersTool = feature('UDS_INBOX')
  ? require('./tools/ListPeersTool/ListPeersTool.js').ListPeersTool
  : null
const WorkflowTool = feature('WORKFLOW_SCRIPTS')
  ? (() => {
      require('./tools/WorkflowTool/bundled/index.js').initBundledWorkflows()
      return require('./tools/WorkflowTool/WorkflowTool.js').WorkflowTool
    })()
  : null
/* eslint-enable custom-rules/no-process-env-top-level, @typescript-eslint/no-require-imports */
import type { ToolPermissionContext } from './Tool.js'
import { getDenyRuleForTool } from './utils/permissions/permissions.js'
import { hasEmbeddedSearchTools } from './utils/embeddedTools.js'
import { isPowerShellToolEnabled } from './utils/shell/shellToolUtils.js'
import { isAgentSwarmsEnabled } from './utils/agentSwarmsEnabled.js'
import { isWorktreeModeEnabled } from './utils/worktreeModeEnabled.js'
import { REPL_TOOL_NAME, REPL_ONLY_TOOLS, isReplModeEnabled } from './tools/REPLTool/constants.js'
export { REPL_ONLY_TOOLS }
/* eslint-disable @typescript-eslint/no-require-imports */
const getPowerShellTool = () => {
  if (!isPowerShellToolEnabled()) return null
  return (
    require('./tools/PowerShellTool/PowerShellTool.js') as typeof import('./tools/PowerShellTool/PowerShellTool.js')
  ).PowerShellTool
}
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * 可与 --tools 标志配合使用的预定义工具预设
 */
export const TOOL_PRESETS = ['default'] as const

export type ToolPreset = (typeof TOOL_PRESETS)[number]

export function parseToolPreset(preset: string): ToolPreset | null {
  const presetString = preset.toLowerCase()
  if (!TOOL_PRESETS.includes(presetString as ToolPreset)) {
    return null
  }
  return presetString as ToolPreset
}

/**
 * 获取指定预设的工具名称列表
 * 过滤掉通过 isEnabled() 检查被禁用的工具
 * @returns 工具名称数组
 */
export function getToolsForDefaultPreset(): string[] {
  const tools = getAllBaseTools()
  const isEnabled = tools.map((tool) => tool.isEnabled())
  return tools.filter((_, i) => isEnabled[i]).map((tool) => tool.name)
}

/**
 * 获取当前环境中所有可用工具的完整列表（遵循 process.env 标志）。
 * 这是所有工具的真实来源。
 */
/**
 * NOTE: 此函数必须与 https://console.statsig.com/4aF3Ewatb6xPVpCwxb5nA3/dynamic_configs/zy_code_global_system_caching 保持同步，以便跨用户缓存系统提示词。
 */
export function getAllBaseTools(): Tools {
  return [
    AgentTool,
    TaskOutputTool,
    BashTool,
    // Ant 原生构建在 bun 二进制文件中嵌入了 bfs/ugrep（与 ripgrep 相同的 ARGV0
    // 技巧）。当可用时，Zy shell 中的 find/grep 会被别名化到这些快速工具，
    // 因此不需要专用的 Glob/Grep 工具。
    ...(hasEmbeddedSearchTools() ? [] : [GlobTool, GrepTool]),
    ExitPlanModeV2Tool,
    FileReadTool,
    FileEditTool,
    FileWriteTool,
    NotebookEditTool,
    WebFetchTool,
    TodoWriteTool,
    WebSearchTool,
    TaskStopTool,
    AskUserQuestionTool,
    SkillTool,
    EnterPlanModeTool,
    ...(isInternalBuild() ? [ConfigTool] : []),
    ...(isInternalBuild() ? [TungstenTool] : []),
    ...(SuggestBackgroundPRTool ? [SuggestBackgroundPRTool] : []),
    ...(WebBrowserTool ? [WebBrowserTool] : []),
    ...(isTodoV2Enabled() ? [TaskCreateTool, TaskGetTool, TaskUpdateTool, TaskListTool] : []),
    ...(OverflowTestTool ? [OverflowTestTool] : []),
    ...(CtxInspectTool ? [CtxInspectTool] : []),
    ...(TerminalCaptureTool ? [TerminalCaptureTool] : []),
    ...(isEnvTruthy(process.env.ENABLE_LSP_TOOL) ? [LSPTool] : []),
    ...(isWorktreeModeEnabled() ? [EnterWorktreeTool, ExitWorktreeTool] : []),
    getSendMessageTool(),
    ...(ListPeersTool ? [ListPeersTool] : []),
    ...(isAgentSwarmsEnabled() ? [getTeamCreateTool(), getTeamDeleteTool()] : []),
    ...(VerifyPlanExecutionTool ? [VerifyPlanExecutionTool] : []),
    ...(isInternalBuild() && REPLTool ? [REPLTool] : []),
    ...(WorkflowTool ? [WorkflowTool] : []),
    ...(SleepTool ? [SleepTool] : []),
    ...cronTools,
    ...(RemoteTriggerTool ? [RemoteTriggerTool] : []),
    ...(MonitorTool ? [MonitorTool] : []),
    BriefTool,
    ...(SendUserFileTool ? [SendUserFileTool] : []),
    ...(PushNotificationTool ? [PushNotificationTool] : []),
    ...(SubscribePRTool ? [SubscribePRTool] : []),
    ...(getPowerShellTool() ? [getPowerShellTool()] : []),
    ...(SnipTool ? [SnipTool] : []),
    ...(process.env.NODE_ENV === 'test' ? [TestingPermissionTool] : []),
    ListMcpResourcesTool,
    ReadMcpResourceTool,
    // 当工具搜索可能启用时（乐观检查），包含 ToolSearchTool
    // 实际的延迟工具决策发生在 zy.ts 的请求时
    ...(isToolSearchEnabledOptimistic() ? [ToolSearchTool] : []),
  ]
}

/**
 * 过滤掉被权限上下文全局拒绝规则禁止的工具。
 * 如果存在与工具名称匹配的拒绝规则且没有 ruleContent（即对该工具的全局拒绝），
 * 则该工具会被过滤掉。
 *
 * 使用与运行时权限检查（步骤 1a）相同的匹配器，因此 MCP 服务器前缀规则
 * （如 `mcp__server`）会在模型看到之前就从该服务器剥离所有工具——
 * 而不仅仅是在调用时。
 */
export function filterToolsByDenyRules<
  T extends {
    name: string
    mcpInfo?: { serverName: string; toolName: string }
  },
>(tools: readonly T[], permissionContext: ToolPermissionContext): T[] {
  return tools.filter((tool) => !getDenyRuleForTool(permissionContext, tool))
}

export const getTools = (permissionContext: ToolPermissionContext): Tools => {
  // 简单模式：仅使用 Bash、Read 和 Edit 工具
  if (isEnvTruthy(process.env.ZY_CODE_SIMPLE)) {
    // --bare + REPL 模式：REPL 在 VM 内部封装了 Bash/Read/Edit 等工具，
    // 因此返回 REPL 而不是原始工具。与下方非 bare 路径一致，
    // 该路径在启用 REPL 时也会隐藏 REPL_ONLY_TOOLS。
    if (isReplModeEnabled() && REPLTool) {
      const replSimple: Tool[] = [REPLTool]
      if (feature('COORDINATOR_MODE') && coordinatorModeModule?.isCoordinatorMode()) {
        replSimple.push(TaskStopTool, getSendMessageTool())
      }
      return filterToolsByDenyRules(replSimple, permissionContext)
    }
    const simpleTools: Tool[] = [BashTool, FileReadTool, FileEditTool]
    // 当协调器模式同时激活时，包含 AgentTool 和 TaskStopTool，
    // 使协调器获得 Task+TaskStop（通过 useMergedTools 过滤），
    // 而工作节点获得 Bash/Read/Edit（通过 filterToolsForAgent 过滤）。
    if (feature('COORDINATOR_MODE') && coordinatorModeModule?.isCoordinatorMode()) {
      simpleTools.push(AgentTool, TaskStopTool, getSendMessageTool())
    }
    return filterToolsByDenyRules(simpleTools, permissionContext)
  }

  // 获取所有基础工具并过滤掉有条件添加的特殊工具
  const specialTools = new Set([
    ListMcpResourcesTool.name,
    ReadMcpResourceTool.name,
    SYNTHETIC_OUTPUT_TOOL_NAME,
  ])

  const tools = getAllBaseTools().filter((tool) => !specialTools.has(tool.name))

  // 过滤掉被拒绝规则禁止的工具
  let allowedTools = filterToolsByDenyRules(tools, permissionContext)

  // 当 REPL 模式启用时，隐藏原始工具的直接使用。
  // 它们仍然可以通过 REPL 内部的 VM 上下文访问。
  if (isReplModeEnabled()) {
    const replEnabled = allowedTools.some((tool) => toolMatchesName(tool, REPL_TOOL_NAME))
    if (replEnabled) {
      allowedTools = allowedTools.filter((tool) => !REPL_ONLY_TOOLS.has(tool.name))
    }
  }

  const isEnabled = allowedTools.map((_) => _.isEnabled())
  return allowedTools.filter((_, i) => isEnabled[i])
}

/**
 * 为给定权限上下文和 MCP 工具组装完整的工具池。
 *
 * 这是将内置工具与 MCP 工具组合的唯一真实来源。
 * REPL.tsx（通过 useMergedTools hook）和 runAgent.ts（用于协调器工作节点）
 * 都使用此函数来确保工具池组装的一致性。
 *
 * 该函数：
 * 1. 通过 getTools() 获取内置工具（遵循模式过滤）
 * 2. 通过拒绝规则过滤 MCP 工具
 * 3. 按工具名称去重（内置工具优先）
 *
 * @param permissionContext - 用于过滤内置工具的权限上下文
 * @param mcpTools - 来自 appState.mcp.tools 的 MCP 工具
 * @returns 去重后的内置工具和 MCP 工具组合数组
 */
export function assembleToolPool(permissionContext: ToolPermissionContext, mcpTools: Tools): Tools {
  const builtInTools = getTools(permissionContext)

  // 过滤掉在拒绝列表中的 MCP 工具
  const allowedMcpTools = filterToolsByDenyRules(mcpTools, permissionContext)

  // 为 prompt 缓存稳定性进行排序，保持内置工具作为连续前缀。
  // 服务器的 zy_code_system_cache_policy 在最后一个前缀匹配的内置工具之后
  // 设置全局缓存断点；扁平排序会将 MCP 工具插入内置工具中，导致每当
  // MCP 工具排序插入现有内置工具之间时，所有下游缓存键失效。
  // uniqBy 保留插入顺序，因此在名称冲突时内置工具优先。
  // 避免使用 Array.toSorted（Node 20+）——我们支持 Node 18。
  // builtInTools 是只读的，所以先复制再排序；allowedMcpTools 是新的 .filter() 结果。
  const byName = (a: Tool, b: Tool) => a.name.localeCompare(b.name)
  return uniqBy([...builtInTools].sort(byName).concat(allowedMcpTools.sort(byName)), 'name')
}

/**
 * 获取所有工具，包括内置工具和 MCP 工具。
 *
 * 当需要以下完整工具列表时，应优先使用此函数：
 * - 工具搜索阈值计算（isToolSearchEnabled）
 * - 包含 MCP 工具的 token 计数
 * - 任何需要考虑 MCP 工具的场景
 *
 * 仅在明确只需要内置工具时使用 getTools()。
 *
 * @param permissionContext - 用于过滤内置工具的权限上下文
 * @param mcpTools - 来自 appState.mcp.tools 的 MCP 工具
 * @returns 内置工具和 MCP 工具的组合数组
 */
export function getMergedTools(permissionContext: ToolPermissionContext, mcpTools: Tools): Tools {
  const builtInTools = getTools(permissionContext)
  return [...builtInTools, ...mcpTools]
}
