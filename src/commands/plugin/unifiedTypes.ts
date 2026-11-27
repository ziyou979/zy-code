/**
 * /plugin「已安装」列表的统一条目类型。
 *
 * ManagePlugins 把插件、插件内 MCP、独立 MCP、加载失败的插件与被下架标记的插件
 * 合并成一个分页列表，UnifiedInstalledCell 按 type 分支渲染。此前该文件缺失，两处
 * 调用方用 @ts-expect-error 把类型退化成 any；这里按实际构造点补齐判别联合。
 */
import type { MCPServerConnection, ConfigScope } from '../../services/mcp/types.js'
import type { LoadedPlugin, PluginError } from '../../services/plugins/types.js'

/** 插件来源作用域（与 ManagePlugins 内 PluginState.scope 一致） */
export type PluginItemScope = 'user' | 'project' | 'local' | 'managed' | 'builtin'

export type McpItemStatus = 'connected' | 'disabled' | 'pending' | 'needs-auth' | 'failed'

export type UnifiedPluginItem = {
  type: 'plugin'
  id: string
  name: string
  description?: string
  marketplace: string
  scope: PluginItemScope
  isEnabled: boolean
  errorCount: number
  errors: PluginError[]
  plugin: LoadedPlugin
  pendingEnable?: boolean
  pendingUpdate?: boolean
  pendingToggle?: 'will-enable' | 'will-disable'
}

export type UnifiedFailedPluginItem = {
  type: 'failed-plugin'
  id: string
  name: string
  marketplace: string
  scope: Exclude<PluginItemScope, 'builtin'>
  errorCount: number
  errors: PluginError[]
}

export type UnifiedFlaggedPluginItem = {
  type: 'flagged-plugin'
  id: string
  name: string
  marketplace: string
  scope: 'flagged'
  reason: string
  text: string
  flaggedAt: string
}

export type UnifiedMcpItem = {
  type: 'mcp'
  id: string
  name: string
  description?: string
  scope: ConfigScope | PluginItemScope
  status: McpItemStatus
  client: MCPServerConnection
  /** 插件下属 MCP 缩进显示在插件之后 */
  indented?: boolean
}

export type UnifiedInstalledItem =
  | UnifiedPluginItem
  | UnifiedFailedPluginItem
  | UnifiedFlaggedPluginItem
  | UnifiedMcpItem
