import { z } from 'zod/v4'
import { lazySchema } from '../../utils/lazySchema.js'
import { PERMISSION_MODES } from '../permissions/permissionMode.js'
import { MarketplaceSourceSchema } from '../plugins/schemas.js'
import { createMcpServerEntrySchema } from './settingsMcpServerEntrySchemas.js'
import { PermissionRuleSchema } from './permissionValidation.js'

/**
 * 环境变量的 Schema
 */
export const EnvironmentVariablesSchema = lazySchema(() => z.record(z.string(), z.coerce.string()))

/**
 * 权限部分的 Schema
 */
export const PermissionsSchema = lazySchema(() =>
  z
    .object({
      allow: z
        .array(PermissionRuleSchema())
        .optional()
        .describe('List of permission rules for allowed operations'),
      deny: z
        .array(PermissionRuleSchema())
        .optional()
        .describe('List of permission rules for denied operations'),
      ask: z
        .array(PermissionRuleSchema())
        .optional()
        .describe('List of permission rules that should always prompt for confirmation'),
      defaultMode: z
        .enum(PERMISSION_MODES)
        .optional()
        .describe('Default permission mode when ZY Code needs access'),
      disableBypassPermissionsMode: z
        .enum(['disable'])
        .optional()
        .describe('Disable the ability to bypass permission prompts'),
      ...(true
        ? {
            disableAutoMode: z.enum(['disable']).optional().describe('Disable auto mode'),
          }
        : {}),
      additionalDirectories: z
        .array(z.string())
        .optional()
        .describe('Additional directories to include in the permission scope'),
    })
    .passthrough(),
)

/**
 * 仓库配置中定义的额外市场的 Schema
 * 与 KnownMarketplace 相同但不包含 lastUpdated（该字段自动管理）
 */
export const ExtraKnownMarketplaceSchema = lazySchema(() =>
  z.object({
    source: MarketplaceSourceSchema().describe('Where to fetch the marketplace from'),
    installLocation: z
      .string()
      .optional()
      .describe(
        'Local cache path where marketplace manifest is stored (auto-generated if not provided)',
      ),
    autoUpdate: z
      .boolean()
      .optional()
      .describe(
        'Whether to automatically update this marketplace and its installed plugins on startup',
      ),
  }),
)

/**
 * 企业白名单中允许的 MCP 服务器条目的 Schema。
 * 支持通过 serverName、serverCommand 或 serverUrl 匹配（互斥）。
 */
export const AllowedMcpServerEntrySchema = createMcpServerEntrySchema({
  nameDescription: 'Name of the MCP server that users are allowed to configure',
  commandDescription: 'Command array [command, ...args] to match exactly for allowed stdio servers',
  urlDescription:
    'URL pattern with wildcard support (e.g., "https://*.example.com/*") for allowed remote MCP servers',
})

/**
 * 企业黑名单中被拒绝的 MCP 服务器条目的 Schema。
 * 支持通过 serverName、serverCommand 或 serverUrl 匹配（互斥）。
 */
export const DeniedMcpServerEntrySchema = createMcpServerEntrySchema({
  nameDescription: 'Name of the MCP server that is explicitly blocked',
  commandDescription: 'Command array [command, ...args] to match exactly for blocked stdio servers',
  urlDescription:
    'URL pattern with wildcard support (e.g., "https://*.example.com/*") for blocked remote MCP servers',
})

/**
 * 可被 `strictPluginOnlyCustomization` 锁定的表面。导出以使
 * schema 预处理（settings/types.ts）和运行时辅助函数
 * （pluginOnlyPolicy.ts）共享唯一的真实来源。
 */
export const CUSTOMIZATION_SURFACES = ['skills', 'agents', 'hooks', 'mcp'] as const

export type AllowedMcpServerEntry = z.infer<ReturnType<typeof AllowedMcpServerEntrySchema>>
export type DeniedMcpServerEntry = z.infer<ReturnType<typeof DeniedMcpServerEntrySchema>>

/**
 * 带 serverName 的 MCP 服务器条目的类型守卫
 */
export function isMcpServerNameEntry(
  entry: AllowedMcpServerEntry | DeniedMcpServerEntry,
): entry is { serverName: string } {
  return 'serverName' in entry && entry.serverName !== undefined
}

/**
 * 带 serverCommand 的 MCP 服务器条目的类型守卫
 */
export function isMcpServerCommandEntry(
  entry: AllowedMcpServerEntry | DeniedMcpServerEntry,
): entry is { serverCommand: string[] } {
  return 'serverCommand' in entry && entry.serverCommand !== undefined
}

/**
 * 带 serverUrl 的 MCP 服务器条目的类型守卫
 */
export function isMcpServerUrlEntry(
  entry: AllowedMcpServerEntry | DeniedMcpServerEntry,
): entry is { serverUrl: string } {
  return 'serverUrl' in entry && entry.serverUrl !== undefined
}
