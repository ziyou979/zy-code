export interface CachedMCConfig {
  enabled: boolean
  supportedModels?: string[]
  systemPromptSuggestSummaries?: boolean
  keepRecent?: number
}

export function getCachedMCConfig(): CachedMCConfig {
  return {
    enabled: false,
    supportedModels: [],
    systemPromptSuggestSummaries: false,
    keepRecent: 5,
  }
}