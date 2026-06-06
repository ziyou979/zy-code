export const AGENT_TOOL_NAME = 'Agent'
// Legacy wire name for backward compat (permission rules, hooks, resumed sessions)
export const LEGACY_AGENT_TOOL_NAME = 'Task'
export const GENERAL_AGENT_TYPE = 'General'
export const VERIFICATION_AGENT_TYPE = 'Verification'
export const GUIDE_AGENT_TYPE = 'Guide'

/**
 * 将 agent type 名称标准化，用于大小写/分隔符不敏感匹配。
 * 规则：转小写 + 所有空格/下划线统一为连字符。
 * 例："Code Reviewer" / "code_reviewer" / "Code-Reviewer" → "code-reviewer"
 */
export function normalizeAgentType(name: string): string {
  return name.toLowerCase().replace(/[\s_]+/g, '-')
}

// Built-in agents that run once and return a report — the parent never
// SendMessages back to continue them. Skip the agentId/SendMessage/usage
// trailer for these to save tokens (~135 chars × 34M Explore runs/week).
export const ONE_SHOT_BUILTIN_AGENT_TYPES: ReadonlySet<string> = new Set([
  'Explore',
  'Plan',
  'Verification',
])
