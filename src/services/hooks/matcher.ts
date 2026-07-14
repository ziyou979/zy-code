import { basename } from 'node:path'
import { DEFAULT_HOOK_SHELL } from 'src/shell-eval/shared/shellProvider.js'
import type { HookCallback, HookCallbackMatcher } from 'src/types/hooks/index.js'
import type { HookEvent, HookInput } from 'src/types/index.js'
import { getRegisteredHooks } from '../../bootstrap/runtime/runtimeContext.js'
import type { AppState } from '../../state/AppState.js'
import { findToolByName, type Tools } from '../../tool.js'
import { createDebugLog } from '../../utils/debug.js'
import {
  getLegacyToolNames,
  normalizeLegacyToolName,
  permissionRuleValueFromString,
} from '../permissions/permissionRuleParser.js'
import { ALLOWED_OFFICIAL_MARKETPLACE_NAMES } from '../plugins/schemas.js'
import type {
  HookCommand,
  HookMatcher,
  PluginHookMatcher,
  SkillHookMatcher,
} from '../settings/types.js'
import { getHooksConfigFromSnapshot, shouldAllowManagedHooksOnly } from './hooksConfigSnapshot.js'
import {
  type FunctionHook,
  getSessionFunctionHooks,
  getSessionHooks,
  type SessionDerivedHookMatcher,
} from './sessionHooks.js'

const hookLog = createDebugLog('hooks')

function matchesPattern(matchQuery: string, matcher: string): boolean {
  if (!matcher || matcher === '*') {
    return true
  }
  // 检查是否为简单字符串或管道分隔列表（除 | 外无正则特殊字符）
  if (/^[a-zA-Z0-9_|]+$/.test(matcher)) {
    // 处理管道分隔的精确匹配
    if (matcher.includes('|')) {
      const patterns = matcher.split('|').map((p) => normalizeLegacyToolName(p.trim()))
      return patterns.includes(matchQuery)
    }
    // 简单精确匹配
    return matchQuery === normalizeLegacyToolName(matcher)
  }

  // 否则视为正则表达式
  try {
    const regex = new RegExp(matcher)
    if (regex.test(matchQuery)) {
      return true
    }
    // 也对旧版名称进行测试，使 "^Task$" 等模式仍然匹配
    for (const legacyName of getLegacyToolNames(matchQuery)) {
      if (regex.test(legacyName)) {
        return true
      }
    }
    return false
  } catch {
    // 如果正则表达式无效，记录错误并返回 false
    hookLog(`Invalid regex pattern in hook matcher: ${matcher}`)
    return false
  }
}

export type IfConditionMatcher = (ifCondition: string) => boolean

/**
 * 为 hook 的 `if` 条件准备匹配器。昂贵的操作（工具查找、
 * Zod 校验、Bash 的 tree-sitter 解析）在此处执行一次；
 * 返回的闭包会对每个 hook 调用。对非工具事件返回 undefined。
 */
async function prepareIfConditionMatcher(
  hookInput: HookInput,
  tools: Tools | undefined,
): Promise<IfConditionMatcher | undefined> {
  if (
    hookInput.hook_event_name !== 'PreToolUse' &&
    hookInput.hook_event_name !== 'PostToolUse' &&
    hookInput.hook_event_name !== 'PostToolUseFailure' &&
    hookInput.hook_event_name !== 'PermissionRequest'
  ) {
    return undefined
  }

  const toolName = normalizeLegacyToolName(hookInput.tool_name)
  const tool = tools && findToolByName(tools, hookInput.tool_name)
  const input = tool?.inputSchema.safeParse(hookInput.tool_input)
  const patternMatcher =
    input?.success && tool?.preparePermissionMatcher
      ? await tool.preparePermissionMatcher(input.data)
      : undefined

  return (ifCondition) => {
    const parsed = permissionRuleValueFromString(ifCondition)
    if (normalizeLegacyToolName(parsed.toolName) !== toolName) {
      return false
    }
    if (!parsed.ruleContent) {
      return true
    }
    return patternMatcher ? patternMatcher(parsed.ruleContent) : false
  }
}

type FunctionHookMatcher = {
  matcher: string
  hooks: FunctionHook[]
}

/**
 * 与可选插件上下文配对的 hook。
 * 返回匹配的 hook 时使用，以便在执行时应用插件环境变量。
 */
export type MatchedHook = {
  hook: HookCommand | HookCallback | FunctionHook
  pluginRoot?: string
  pluginId?: string
  skillRoot?: string
  hookSource?: string
}

export function isInternalHook(matched: MatchedHook): boolean {
  return matched.hook.type === 'callback' && matched.hook.internal === true
}

/**
 * 为匹配的 hook 构建去重 key，按来源上下文命名空间化。
 *
 * 设置文件 hook（无 pluginRoot/skillRoot）共享 '' 前缀，因此
 * 在 user/project/local 中定义的相同命令仍会合并为一个——这是
 * 去重的原始意图。插件/技能 hook 以其根目录作为前缀，因此
 * 两个插件共享未展开的 `${CLAUDE_PLUGIN_ROOT}/hook.sh` 模板
 * 不会合并：展开后它们指向不同的文件。
 */
function hookDedupKey(m: MatchedHook, payload: string): string {
  return `${m.pluginRoot ?? m.skillRoot ?? ''}\0${payload}`
}

/**
 * 从匹配的 hook 构建 {sanitizedPluginName: hookCount} 映射。
 * 仅记录官方市场插件的实际名称；其他归为 'third-party'。
 */
export function getPluginHookCounts(hooks: MatchedHook[]): Record<string, number> | undefined {
  const pluginHooks = hooks.filter((h) => h.pluginId)
  if (pluginHooks.length === 0) {
    return undefined
  }
  const counts: Record<string, number> = {}
  for (const h of pluginHooks) {
    const atIndex = h.pluginId!.lastIndexOf('@')
    const isOfficial =
      atIndex > 0 && ALLOWED_OFFICIAL_MARKETPLACE_NAMES.has(h.pluginId!.slice(atIndex + 1))
    const key = isOfficial ? h.pluginId! : 'third-party'
    counts[key] = (counts[key] || 0) + 1
  }
  return counts
}

/**
 * 从匹配的 hook 构建 {hookType: count} 映射。
 */
export function getHookTypeCounts(hooks: MatchedHook[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const h of hooks) {
    counts[h.hook.type] = (counts[h.hook.type] || 0) + 1
  }
  return counts
}

function getHooksConfig(
  appState: AppState | undefined,
  sessionId: string,
  hookEvent: HookEvent,
): Array<
  | HookMatcher
  | HookCallbackMatcher
  | FunctionHookMatcher
  | PluginHookMatcher
  | SkillHookMatcher
  | SessionDerivedHookMatcher
> {
  // HookMatcher 是经过 zod 剥离的 {matcher, hooks}，因此快照匹配器
  // 可以直接 push 而无需重新包装。
  const hooks: Array<
    | HookMatcher
    | HookCallbackMatcher
    | FunctionHookMatcher
    | PluginHookMatcher
    | SkillHookMatcher
    | SessionDerivedHookMatcher
  > = [...(getHooksConfigFromSnapshot()?.[hookEvent] ?? [])]

  // 检查是否只应运行托管 hook（用于注册 hook 和会话 hook）
  const managedOnly = shouldAllowManagedHooksOnly()

  // 处理已注册的 hook（SDK callback 和插件原生 hook）
  const registeredHooks = getRegisteredHooks()?.[hookEvent]
  if (registeredHooks) {
    for (const matcher of registeredHooks) {
      // 当限制为仅托管 hook 时跳过插件 hook
      // 插件 hook 设置了 pluginRoot，SDK callback 则没有
      if (managedOnly && 'pluginRoot' in matcher) {
        continue
      }
      hooks.push(matcher)
    }
  }

  // Merge session hooks for the current session only
  // Function hooks (like structured output enforcement) must be scoped to their session
  // to prevent hooks from one agent leaking to another (e.g., verification agent to main agent)
  // Skip session hooks entirely when allowManagedHooksOnly is set —
  // this prevents frontmatter hooks from agents/skills from bypassing the policy.
  // strictPluginOnlyCustomization does NOT block here — it gates at the
  // REGISTRATION sites (runAgent.ts:526 for agent frontmatter hooks) where
  // agentDefinition.source is known. A blanket block here would also kill
  // plugin-provided agents' frontmatter hooks, which is too broad.
  // Also skip if appState not provided (for backwards compatibility)
  if (!managedOnly && appState !== undefined) {
    const sessionHooks = getSessionHooks(appState, sessionId, hookEvent).get(hookEvent)
    if (sessionHooks) {
      // SessionDerivedHookMatcher 已包含可选的 skillRoot
      for (const matcher of sessionHooks) {
        hooks.push(matcher)
      }
    }

    // 单独合并会话函数 hook（无法持久化为 HookMatcher 格式）
    const sessionFunctionHooks = getSessionFunctionHooks(appState, sessionId, hookEvent).get(
      hookEvent,
    )
    if (sessionFunctionHooks) {
      for (const matcher of sessionFunctionHooks) {
        hooks.push(matcher)
      }
    }
  }

  return hooks
}

/**
 * Lightweight existence check for hooks on a given event. Mirrors the sources
 * assembled by getHooksConfig() but stops at the first hit without building
 * the full merged config.
 *
 * Intentionally over-approximates: returns true if any matcher exists for the
 * event, even if managed-only filtering or pattern matching would later
 * discard it. A false positive just means we proceed to the full matching
 * path; a false negative would skip a hook, so we err on the side of true.
 *
 * Used to skip createBaseHookInput (getTranscriptPathForSession path joins)
 * and getMatchingHooks on hot paths where hooks are typically unconfigured.
 * See hasInstructionsLoadedHook / hasWorktreeCreateHook for the same pattern.
 */
export function hasHookForEvent(
  hookEvent: HookEvent,
  appState: AppState | undefined,
  sessionId: string,
): boolean {
  const snap = getHooksConfigFromSnapshot()?.[hookEvent]
  if (snap && snap.length > 0) {
    return true
  }
  const reg = getRegisteredHooks()?.[hookEvent]
  if (reg && reg.length > 0) {
    return true
  }
  if (appState?.sessionHooks.get(sessionId)?.hooks[hookEvent]) {
    return true
  }
  return false
}

/**
 * Get hook commands that match the given query
 * @param appState The current app state (optional for backwards compatibility)
 * @param sessionId The current session ID (main session or agent ID)
 * @param hookEvent The hook event
 * @param hookInput The hook input for matching
 * @returns Array of matched hooks with optional plugin context
 */
export async function getMatchingHooks(
  appState: AppState | undefined,
  sessionId: string,
  hookEvent: HookEvent,
  hookInput: HookInput,
  tools?: Tools,
): Promise<MatchedHook[]> {
  try {
    const hookMatchers = getHooksConfig(appState, sessionId, hookEvent)

    // 如果更改以下条件，必须同时更改
    // 兼容 hooksConfigManager.ts 的历史调用约定。
    let matchQuery: string | undefined
    switch (hookInput.hook_event_name) {
      case 'PreToolUse':
      case 'PostToolUse':
      case 'PostToolUseFailure':
      case 'PermissionRequest':
      case 'PermissionDenied':
        matchQuery = hookInput.tool_name
        break
      case 'SessionStart':
        matchQuery = hookInput.source
        break
      case 'Setup':
        matchQuery = hookInput.trigger
        break
      case 'PreCompact':
      case 'PostCompact':
        matchQuery = hookInput.trigger
        break
      case 'Notification':
        matchQuery = hookInput.notification_type
        break
      case 'SessionEnd':
        matchQuery = hookInput.reason
        break
      case 'StopFailure':
        matchQuery = hookInput.error
        break
      case 'SubagentStart':
        matchQuery = hookInput.agent_type
        break
      case 'SubagentStop':
        matchQuery = hookInput.agent_type
        break
      case 'TeammateIdle':
      case 'TaskCreated':
      case 'TaskCompleted':
        break
      case 'Elicitation':
        matchQuery = hookInput.mcp_server_name
        break
      case 'ElicitationResult':
        matchQuery = hookInput.mcp_server_name
        break
      case 'ConfigChange':
        matchQuery = hookInput.source
        break
      case 'InstructionsLoaded':
        matchQuery = hookInput.load_reason
        break
      case 'FileChanged':
        matchQuery = basename(hookInput.file_path)
        break
      default:
        break
    }

    hookLog(`Getting matching hook commands for ${hookEvent} with query: ${matchQuery}`, {
      level: 'verbose',
    })
    hookLog(`Found ${hookMatchers.length} hook matchers in settings`, {
      level: 'verbose',
    })

    // 提取 hook 及其插件上下文（如有）
    const filteredMatchers = matchQuery
      ? hookMatchers.filter(
          (matcher) => !matcher.matcher || matchesPattern(matchQuery, matcher.matcher),
        )
      : hookMatchers

    const matchedHooks: MatchedHook[] = filteredMatchers.flatMap((matcher) => {
      // 检查是否为 PluginHookMatcher（有 pluginRoot）或 SkillHookMatcher（有 skillRoot）
      const pluginRoot = 'pluginRoot' in matcher ? matcher.pluginRoot : undefined
      const pluginId = 'pluginId' in matcher ? matcher.pluginId : undefined
      const skillRoot = 'skillRoot' in matcher ? matcher.skillRoot : undefined
      const hookSource = pluginRoot
        ? 'pluginName' in matcher
          ? `plugin:${matcher.pluginName}`
          : 'plugin'
        : skillRoot
          ? 'skillName' in matcher
            ? `skill:${matcher.skillName}`
            : 'skill'
          : 'settings'
      return matcher.hooks.map((hook) => ({
        hook,
        pluginRoot,
        pluginId,
        skillRoot,
        hookSource,
      }))
    })

    // Deduplicate hooks by command/prompt/url within the same source context.
    // Key is namespaced by pluginRoot/skillRoot (see hookDedupKey above) so
    // cross-plugin template collisions don't drop hooks (gh-29724).
    //
    // Note: new Map(entries) keeps the LAST entry on key collision, not first.
    // For settings hooks this means the last-merged scope wins; for
    // same-plugin duplicates the pluginRoot is identical so it doesn't matter.
    // Fast-path: callback/function hooks don't need dedup (each is unique).
    // Skip the 6-pass filter + 4×Map + 4×Array.from below when all hooks are
    // callback/function — the common case for internal hooks like
    // sessionFileAccessHooks/attributionHooks (44x faster in microbench).
    if (matchedHooks.every((m) => m.hook.type === 'callback' || m.hook.type === 'function')) {
      return matchedHooks
    }

    // Helper to extract the `if` condition from a hook for dedup keys.
    // Hooks with different `if` conditions are distinct even if otherwise identical.
    const getIfCondition = (hook: { if?: string }): string => hook.if ?? ''

    const uniqueCommandHooks = Array.from(
      new Map(
        matchedHooks
          .filter(
            (m): m is MatchedHook & { hook: HookCommand & { type: 'command' } } =>
              m.hook.type === 'command',
          )
          // shell is part of identity: {command:'echo x', shell:'bash'}
          // and {command:'echo x', shell:'powershell'} are distinct hooks,
          // not duplicates. Default to 'bash' so legacy configs (no shell
          // field) still dedup against explicit shell:'bash'.
          .map((m) => [
            hookDedupKey(
              m,
              `${m.hook.shell ?? DEFAULT_HOOK_SHELL}\0${m.hook.command}\0${getIfCondition(m.hook)}`,
            ),
            m,
          ]),
      ).values(),
    )
    const uniquePromptHooks = Array.from(
      new Map(
        matchedHooks
          .filter((m) => m.hook.type === 'prompt')
          .map((m) => [
            hookDedupKey(
              m,
              `${(m.hook as { prompt: string }).prompt}\0${getIfCondition(m.hook as { if?: string })}`,
            ),
            m,
          ]),
      ).values(),
    )
    const uniqueAgentHooks = Array.from(
      new Map(
        matchedHooks
          .filter((m) => m.hook.type === 'agent')
          .map((m) => [
            hookDedupKey(
              m,
              `${(m.hook as { prompt: string }).prompt}\0${getIfCondition(m.hook as { if?: string })}`,
            ),
            m,
          ]),
      ).values(),
    )
    const uniqueHttpHooks = Array.from(
      new Map(
        matchedHooks
          .filter((m) => m.hook.type === 'http')
          .map((m) => [
            hookDedupKey(
              m,
              `${(m.hook as { url: string }).url}\0${getIfCondition(m.hook as { if?: string })}`,
            ),
            m,
          ]),
      ).values(),
    )
    const uniqueMcpToolHooks = Array.from(
      new Map(
        matchedHooks
          .filter((m) => m.hook.type === 'mcp_tool')
          .map((m) => [
            hookDedupKey(
              m,
              `${(m.hook as { server: string }).server}\0${(m.hook as { tool: string }).tool}\0${getIfCondition(m.hook as { if?: string })}`,
            ),
            m,
          ]),
      ).values(),
    )
    const callbackHooks = matchedHooks.filter((m) => m.hook.type === 'callback')
    // 函数 hook 不需要去重——每个 callback 都是唯一的
    const functionHooks = matchedHooks.filter((m) => m.hook.type === 'function')
    const uniqueHooks = [
      ...uniqueCommandHooks,
      ...uniquePromptHooks,
      ...uniqueAgentHooks,
      ...uniqueHttpHooks,
      ...uniqueMcpToolHooks,
      ...callbackHooks,
      ...functionHooks,
    ]

    // Filter hooks based on their `if` condition. This allows hooks to specify
    // conditions like "Bash(git *)" to only run for git commands, avoiding
    // process spawning overhead for non-matching commands.
    const hasIfCondition = uniqueHooks.some(
      (h) =>
        (h.hook.type === 'command' ||
          h.hook.type === 'prompt' ||
          h.hook.type === 'agent' ||
          h.hook.type === 'http' ||
          h.hook.type === 'mcp_tool') &&
        (h.hook as { if?: string }).if,
    )
    const ifMatcher = hasIfCondition ? await prepareIfConditionMatcher(hookInput, tools) : undefined
    const ifFilteredHooks = uniqueHooks.filter((h) => {
      if (
        h.hook.type !== 'command' &&
        h.hook.type !== 'prompt' &&
        h.hook.type !== 'agent' &&
        h.hook.type !== 'http' &&
        h.hook.type !== 'mcp_tool'
      ) {
        return true
      }
      const ifCondition = (h.hook as { if?: string }).if
      if (!ifCondition) {
        return true
      }
      if (!ifMatcher) {
        hookLog(
          `Hook if condition "${ifCondition}" cannot be evaluated for non-tool event ${hookInput.hook_event_name}`,
        )
        return false
      }
      if (ifMatcher(ifCondition)) {
        return true
      }
      hookLog(`Skipping hook due to if condition "${ifCondition}" not matching`)
      return false
    })

    // HTTP hooks are not supported for SessionStart/Setup events. In headless
    // mode the sandbox ask callback deadlocks because the structuredInput
    // consumer hasn't started yet when these hooks fire.
    const filteredHooks =
      hookEvent === 'SessionStart' || hookEvent === 'Setup'
        ? ifFilteredHooks.filter((h) => {
            if (h.hook.type === 'http') {
              hookLog(
                `Skipping HTTP hook ${(h.hook as { url: string }).url} — HTTP hooks are not supported for ${hookEvent}`,
              )
              return false
            }
            return true
          })
        : ifFilteredHooks

    hookLog(
      `Matched ${filteredHooks.length} unique hooks for query "${matchQuery || 'no match query'}" (${matchedHooks.length} before deduplication)`,
      { level: 'verbose' },
    )
    return filteredHooks
  } catch {
    return []
  }
}
