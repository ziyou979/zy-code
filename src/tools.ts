// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { feature } from 'bun:bundle'
import { toolMatchesName, type Tool, type Tools } from './Tool.js'
import type { ToolPermissionContext } from './Tool.js'
import { isEnvTruthy, isInternalBuild } from './utils/envUtils.js'
import { toolRegistry } from './tools/registry.js'
export { loadExternalTools, hasExternalToolOverride } from './tools/externalToolLoader.js'
import uniqBy from 'lodash-es/uniqBy.js'
import { getDenyRuleForTool } from './utils/permissions/permissions.js'
import { REPL_TOOL_NAME, REPL_ONLY_TOOLS, isReplModeEnabled } from './tools/REPLTool/constants.js'
import { SYNTHETIC_OUTPUT_TOOL_NAME } from './tools/SyntheticOutputTool/SyntheticOutputTool.js'
export { REPL_ONLY_TOOLS }
export {
  ALL_AGENT_DISALLOWED_TOOLS,
  CUSTOM_AGENT_DISALLOWED_TOOLS,
  ASYNC_AGENT_ALLOWED_TOOLS,
  COORDINATOR_MODE_ALLOWED_TOOLS,
} from './constants/tools.js'

// ─── Value imports: getTools() 简单模式直接引用的工具 ───────────────
import { AgentTool } from './tools/AgentTool/AgentTool.js'
import { BashTool } from './tools/BashTool/BashTool.js'
import { FileReadTool } from './tools/FileReadTool/FileReadTool.js'
import { FileEditTool } from './tools/FileEditTool/FileEditTool.js'
import { TaskStopTool } from './tools/TaskStopTool/TaskStopTool.js'

// ─── Side-effect imports: 触发模块加载 → 自注册到 toolRegistry ──────
import './tools/SkillTool/SkillTool.js'
import './tools/FileWriteTool/FileWriteTool.js'
import './tools/GlobTool/GlobTool.js'
import './tools/GrepTool/GrepTool.js'
import './tools/NotebookEditTool/NotebookEditTool.js'
import './tools/WebFetchTool/WebFetchTool.js'
import './tools/BriefTool/BriefTool.js'
import './tools/TaskOutputTool/TaskOutputTool.js'
import './tools/WebSearchTool/WebSearchTool.js'
import './tools/TodoWriteTool/TodoWriteTool.js'
import './tools/ExitPlanModeTool/ExitPlanModeV2Tool.js'
import './tools/AskUserQuestionTool/AskUserQuestionTool.js'
import './tools/EnterPlanModeTool/EnterPlanModeTool.js'
import './tools/EnterWorktreeTool/EnterWorktreeTool.js'
import './tools/ExitWorktreeTool/ExitWorktreeTool.js'
import './tools/LSPTool/LSPTool.js'
import './tools/ListMcpResourcesTool/ListMcpResourcesTool.js'
import './tools/ReadMcpResourceTool/ReadMcpResourceTool.js'
import './tools/ToolSearchTool/ToolSearchTool.js'
import './tools/TaskCreateTool/TaskCreateTool.js'
import './tools/TaskGetTool/TaskGetTool.js'
import './tools/TaskUpdateTool/TaskUpdateTool.js'
import './tools/TaskListTool/TaskListTool.js'
import './tools/PowerShellTool/PowerShellTool.js'
import './tools/testing/TestingPermissionTool.js'

// ─── DCE 条件加载: 仅触发模块加载（自注册），不提取值 ─────────────
/* eslint-disable custom-rules/no-process-env-top-level, @typescript-eslint/no-require-imports */
const REPLTool = isInternalBuild() ? require('./tools/REPLTool/REPLTool.js').REPLTool : null
if (isInternalBuild()) {
  require('./tools/SuggestBackgroundPRTool/SuggestBackgroundPRTool.js')
  require('./tools/ConfigTool/ConfigTool.js')
  require('./tools/TungstenTool/TungstenTool.js')
}
if (feature('PROACTIVE') || feature('KAIROS')) {
  require('./tools/SleepTool/SleepTool.js')
}
if (feature('AGENT_TRIGGERS')) {
  require('./tools/ScheduleCronTool/CronCreateTool.js')
  require('./tools/ScheduleCronTool/CronDeleteTool.js')
  require('./tools/ScheduleCronTool/CronListTool.js')
}
if (feature('AGENT_TRIGGERS_REMOTE')) {
  require('./tools/RemoteTriggerTool/RemoteTriggerTool.js')
}
if (feature('MONITOR_TOOL')) {
  require('./tools/MonitorTool/MonitorTool.js')
}
if (feature('KAIROS')) {
  require('./tools/SendUserFileTool/SendUserFileTool.js')
}
if (feature('KAIROS') || feature('KAIROS_PUSH_NOTIFICATION')) {
  require('./tools/PushNotificationTool/PushNotificationTool.js')
}
if (feature('KAIROS_GITHUB_WEBHOOKS')) {
  require('./tools/SubscribePRTool/SubscribePRTool.js')
}
if (feature('OVERFLOW_TEST_TOOL')) {
  require('./tools/OverflowTestTool/OverflowTestTool.js')
}
if (feature('CONTEXT_COLLAPSE')) {
  require('./tools/CtxInspectTool/CtxInspectTool.js')
}
if (feature('TERMINAL_PANEL')) {
  require('./tools/TerminalCaptureTool/TerminalCaptureTool.js')
}
if (feature('WEB_BROWSER_TOOL')) {
  require('./tools/WebBrowserTool/WebBrowserTool.js')
}
if (feature('UDS_INBOX')) {
  require('./tools/ListPeersTool/ListPeersTool.js')
}
if (feature('WORKFLOW_SCRIPTS')) {
  require('./tools/WorkflowTool/bundled/index.js').initBundledWorkflows()
  require('./tools/WorkflowTool/WorkflowTool.js')
}
if (process.env.ZY_CODE_VERIFY_PLAN === 'true') {
  require('./tools/VerifyPlanExecutionTool/VerifyPlanExecutionTool.js')
}
const coordinatorModeModule = feature('COORDINATOR_MODE')
  ? (require('./coordinator/coordinatorMode.js') as typeof import('./coordinator/coordinatorMode.js'))
  : null
// 延迟 require 以打破循环依赖
const getSendMessageTool = () =>
  require('./tools/SendMessageTool/SendMessageTool.js')
    .SendMessageTool as typeof import('./tools/SendMessageTool/SendMessageTool.js').SendMessageTool
// TeamCreateTool/TeamDeleteTool 通过 side-effect import 触发 → 自注册带条件
/* eslint-enable custom-rules/no-process-env-top-level, @typescript-eslint/no-require-imports */

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
 * 条件过滤由各工具注册时的 condition 函数控制。
 *
 * NOTE: 此函数必须与 https://console.statsig.com/4aF3Ewatb6xPVpCwxb5nA3/dynamic_configs/zy_code_global_system_caching 保持同步，以便跨用户缓存系统提示词。
 */
export function getAllBaseTools(): Tools {
  return toolRegistry.getAll()
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

  // 获取非特殊工具（special 标记的工具 + SyntheticOutputTool 排除）
  const tools = toolRegistry
    .getAll({ excludeSpecial: true })
    .filter((tool) => tool.name !== SYNTHETIC_OUTPUT_TOOL_NAME)

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
