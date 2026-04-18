// Plugin Command Types

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
