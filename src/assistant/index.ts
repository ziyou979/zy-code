/**
 * KAIROS assistant mode 模块
 *
 * 提供 assistant mode 的核心状态管理和 prompt 生成。
 * Assistant mode 是 Agent SDK 守护进程模式的基础，
 * 支持后台 agent、proactive 发起对话等能力。
 */

let _assistantMode = false
let _assistantForced = false

export function isAssistantMode(): boolean {
  return _assistantMode
}

export function enableAssistantMode(): void {
  _assistantMode = true
  _assistantForced = false
}

export function disableAssistantMode(): void {
  _assistantMode = false
  _assistantForced = false
}

/** 由 --assistant CLI 标志触发，强制启用（跳过门控检查） */
export function markAssistantForced(): void {
  _assistantForced = true
  _assistantMode = true
}

/** 检查是否由 --assistant 强制启用 */
export function isAssistantForced(): boolean {
  return _assistantForced
}

/** 获取 assistant mode 的系统 prompt 补充段落 */
export function getAssistantSystemPromptAddendum(): string {
  return `\n# Assistant Mode\n\nYou are running as a background assistant. The user may not see every message immediately — be concise and actionable. When you have completed the user's request, summarize briefly. Long-running work should be delegated to subagents.`
}

/** 获取 assistant mode 的激活路径（用于日志和诊断） */
export function getAssistantActivationPath(): string {
  if (_assistantForced) return 'cli:--assistant'
  return 'settings:kairosEnabled'
}

/**
 * 初始化 assistant 团队上下文。
 * ZY Code 暂不需要完整的团队/队友管理，
 * 返回最小上下文供 main.tsx 消费。
 */
export async function initializeAssistantTeam(): Promise<undefined> {
  return undefined
}
