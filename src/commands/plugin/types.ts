// Plugin Command Types

// biome-ignore lint/suspicious/noExplicitAny: 运行时动态类型处理
export type ViewState = any

export type PluginSettingsProps = {
  onComplete: () => void
  initialView?: ViewState
  pluginName?: string
  initialTab?: string
}

export interface PluginInfo {
  name: string
  description: string
  version: string
  source: string
  enabled: boolean
}

export interface MarketplaceInfo {
  name: string
  url: string
  plugins: PluginInfo[]
}
