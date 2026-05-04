export function shouldGenerateTaskSummary(): boolean {
  return false
}

export function maybeGenerateTaskSummary(_opts: {
  systemPrompt: unknown
  userContext: unknown
  systemContext: unknown
  toolUseContext: unknown
  forkContextMessages: unknown[]
}): void {
  // no-op: ZY Code 暂不需要任务摘要
}
