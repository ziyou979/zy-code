import { feature } from 'bun:bundle'
import { z } from 'zod/v4'
import { SandboxSettingsSchema } from '../../entrypoints/sandboxTypes.js'
import { isEnvTruthy, isInternalBuild } from '../envUtils.js'
import { lazySchema } from '../lazySchema.js'
import { EXTERNAL_PERMISSION_MODES, PERMISSION_MODES } from '../permissions/PermissionMode.js'
import { MarketplaceSourceSchema } from '../plugins/schemas.js'
import { ZY_CODE_SETTINGS_SCHEMA_URL } from './constants.js'
import { PermissionRuleSchema } from './permissionValidation.js'

// 从集中位置重新导出 hook schemas 和类型，保持向后兼容性
export {
  type AgentHook,
  type BashCommandHook,
  type HookCommand,
  HookCommandSchema,
  type HookMatcher,
  HookMatcherSchema,
  HooksSchema,
  type HooksSettings,
  type HttpHook,
  type PromptHook,
} from '../../schemas/hooks.js'

// 同时导入以在本文件中使用
import { type HookCommand, HooksSchema } from '../../schemas/hooks.js'
import { count } from '../array.js'

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
        .enum(feature('TRANSCRIPT_CLASSIFIER') ? PERMISSION_MODES : EXTERNAL_PERMISSION_MODES)
        .optional()
        .describe('Default permission mode when ZY Code needs access'),
      disableBypassPermissionsMode: z
        .enum(['disable'])
        .optional()
        .describe('Disable the ability to bypass permission prompts'),
      ...(feature('TRANSCRIPT_CLASSIFIER')
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
export const AllowedMcpServerEntrySchema = lazySchema(() =>
  z
    .object({
      serverName: z
        .string()
        .regex(
          /^[a-zA-Z0-9_-]+$/,
          'Server name can only contain letters, numbers, hyphens, and underscores',
        )
        .optional()
        .describe('Name of the MCP server that users are allowed to configure'),
      serverCommand: z
        .array(z.string())
        .min(1, 'Server command must have at least one element (the command)')
        .optional()
        .describe('Command array [command, ...args] to match exactly for allowed stdio servers'),
      serverUrl: z
        .string()
        .optional()
        .describe(
          'URL pattern with wildcard support (e.g., "https://*.example.com/*") for allowed remote MCP servers',
        ),
      // 未来扩展性：allowedTransports、requiredArgs、maxInstances 等
    })
    .refine(
      (data) => {
        const defined = count(
          [
            data.serverName !== undefined,
            data.serverCommand !== undefined,
            data.serverUrl !== undefined,
          ],
          Boolean,
        )
        return defined === 1
      },
      {
        message: 'Entry must have exactly one of "serverName", "serverCommand", or "serverUrl"',
      },
    ),
)

/**
 * 企业黑名单中被拒绝的 MCP 服务器条目的 Schema。
 * 支持通过 serverName、serverCommand 或 serverUrl 匹配（互斥）。
 */
export const DeniedMcpServerEntrySchema = lazySchema(() =>
  z
    .object({
      serverName: z
        .string()
        .regex(
          /^[a-zA-Z0-9_-]+$/,
          'Server name can only contain letters, numbers, hyphens, and underscores',
        )
        .optional()
        .describe('Name of the MCP server that is explicitly blocked'),
      serverCommand: z
        .array(z.string())
        .min(1, 'Server command must have at least one element (the command)')
        .optional()
        .describe('Command array [command, ...args] to match exactly for blocked stdio servers'),
      serverUrl: z
        .string()
        .optional()
        .describe(
          'URL pattern with wildcard support (e.g., "https://*.example.com/*") for blocked remote MCP servers',
        ),
      // 未来扩展性：reason、blockedSince 等
    })
    .refine(
      (data) => {
        const defined = count(
          [
            data.serverName !== undefined,
            data.serverCommand !== undefined,
            data.serverUrl !== undefined,
          ],
          Boolean,
        )
        return defined === 1
      },
      {
        message: 'Entry must have exactly one of "serverName", "serverCommand", or "serverUrl"',
      },
    ),
)

/**
 * 配置文件的统一 Schema
 *
 * ⚠️ 向后兼容性注意事项 ⚠️
 *
 * 此 schema 定义了用户配置文件（.zy/settings.json）的结构。
 * 我们支持向后兼容的变更！方法如下：
 *
 * ✅ 允许的变更：
 * - 添加新的可选字段（始终使用 .optional()）
 * - 添加新的枚举值（保留现有值）
 * - 向对象添加新属性
 * - 使验证更加宽松
 * - 使用联合类型进行渐进式迁移（如 z.union([oldType, newType])）
 *
 * ❌ 应避免的破坏性变更：
 * - 删除字段（改为标记为已弃用）
 * - 删除枚举值
 * - 将可选字段改为必填
 * - 使类型更加严格
 * - 重命名字段而不保留旧名称
 *
 * 确保向后兼容性的方法：
 * 1. 运行：npm run test:file -- test/utils/settings/backward-compatibility.test.ts
 * 2. 如果测试失败，说明引入了破坏性变更
 * 3. 添加新字段时，在 BACKWARD_COMPATIBILITY_CONFIGS 中添加测试
 *
 * 配置系统自动处理向后兼容性：
 * - 更新配置时，无效字段会保留在文件中（见 settings.ts 第 233-249 行）
 * - 通过 z.coerce 进行类型转换（如环境变量将数字转换为字符串）
 * - .passthrough() 保留权限对象中的未知字段
 * - 无效配置只是不被使用，但保留在文件中供用户修复
 */

/**
 * 可被 `strictPluginOnlyCustomization` 锁定的表面。导出以使
 * schema 预处理（下方）和运行时辅助函数（pluginOnlyPolicy.ts）
 * 共享唯一的真实来源。
 */
export const CUSTOMIZATION_SURFACES = ['skills', 'agents', 'hooks', 'mcp'] as const

export const SettingsSchema = lazySchema(() =>
  z
    .object({
      $schema: z
        .literal(ZY_CODE_SETTINGS_SCHEMA_URL)
        .optional()
        .describe('JSON Schema reference for ZY Code settings'),
      apiKeyHelper: z
        .string()
        .optional()
        .describe('Path to a script that outputs authentication values'),
      /** API 提供商：'anthropic'、'dashscope'、'openrouter'、'generic'、'local'、'zhipu'、'kimi' */
      provider: z
        .enum(['anthropic', 'dashscope', 'openrouter', 'generic', 'local', 'zhipu', 'kimi'])
        .optional()
        .describe('API provider to use. Overrides onboarding config and env vars.'),
      /** 配置的提供商的 API 密钥 */
      apiKey: z
        .string()
        .optional()
        .describe('API key for authentication. Overrides environment variables.'),
      /** 主循环层级：主对话循环使用的能力层级 */
      mainLoopModel: z
        .enum(['advanced', 'standard', 'compact'])
        .optional()
        .describe(
          'Capability tier for the main conversation loop. "advanced" for complex reasoning, ' +
            '"standard" for everyday tasks, "compact" for fast/lightweight tasks. ' +
            'Defaults to "standard". The actual model is resolved from the "models" configuration.',
        ),
      /** 基于层级的模型配置（advanced > standard > compact） */
      models: z
        .record(z.string(), z.string())
        .optional()
        .describe(
          'Model configuration by capability tier. Keys: ' +
            '"advanced" (complex reasoning), "standard" (everyday tasks), "compact" (fast/cheap). ' +
            'At least the tier referenced by "mainLoopModel" must be configured.',
        ),
      awsCredentialExport: z
        .string()
        .optional()
        .describe('Path to a script that exports AWS credentials'),
      awsAuthRefresh: z
        .string()
        .optional()
        .describe('Path to a script that refreshes AWS authentication'),
      gcpAuthRefresh: z
        .string()
        .optional()
        .describe(
          'Command to refresh GCP authentication (e.g., gcloud auth application-default login)',
        ),
      // 受限制以使 SDK 生成器（在没有 ZY_CODE_ENABLE_XAA 时运行）
      // 不在 GlobalZySettings 中暴露此字段。通过 getXaaIdpSettings() 读取。
      // 外部对象的 .passthrough() 使现有 settings.json 中的键
      // 在环境变量关闭的会话中保持存活 - 只是不进行 schema 验证。
      ...(isEnvTruthy(process.env.ZY_CODE_ENABLE_XAA)
        ? {
            xaaIdp: z
              .object({
                issuer: z.string().url().describe('IdP issuer URL for OIDC discovery'),
                clientId: z.string().describe("ZY Code's client_id registered at the IdP"),
                callbackPort: z
                  .number()
                  .int()
                  .positive()
                  .optional()
                  .describe(
                    'Fixed loopback callback port for the IdP OIDC login. ' +
                      'Only needed if the IdP does not honor RFC 8252 port-any matching.',
                  ),
              })
              .optional()
              .describe(
                'XAA (SEP-990) IdP connection. Configure once; all XAA-enabled MCP servers reuse this.',
              ),
          }
        : {}),
      fileSuggestion: z
        .object({
          type: z.literal('command'),
          command: z.string(),
        })
        .optional()
        .describe('Custom file suggestion configuration for @ mentions'),
      respectGitignore: z
        .boolean()
        .optional()
        .describe(
          'Whether file picker should respect .gitignore files (default: true). ' +
            'Note: .ignore files are always respected.',
        ),
      cleanupPeriodDays: z
        .number()
        .nonnegative()
        .int()
        .optional()
        .describe(
          'Number of days to retain chat transcripts (default: 30). Setting to 0 disables session persistence entirely: no transcripts are written and existing transcripts are deleted at startup.',
        ),
      env: EnvironmentVariablesSchema()
        .optional()
        .describe('Environment variables to set for ZY Code sessions'),
      // 提交和 PR 的署名归属
      attribution: z
        .object({
          commit: z
            .string()
            .optional()
            .describe(
              'Attribution text for git commits, including any trailers. ' +
                'Empty string hides attribution.',
            ),
          pr: z
            .string()
            .optional()
            .describe(
              'Attribution text for pull request descriptions. ' +
                'Empty string hides attribution.',
            ),
        })
        .optional()
        .describe(
          'Customize attribution text for commits and PRs. ' +
            'Each field defaults to the standard ZY Code attribution if not set.',
        ),
      includeCoAuthoredBy: z
        .boolean()
        .optional()
        .describe(
          'Deprecated: Use attribution instead. ' +
            "Whether to include Zy's co-authored by attribution in commits and PRs (defaults to true)",
        ),
      includeGitInstructions: z
        .boolean()
        .optional()
        .describe(
          'Include built-in commit and PR workflow instructions in the system prompt (default: true)',
        ),
      permissions: PermissionsSchema().optional().describe('Tool usage permissions configuration'),
      model: z.string().optional().describe('Override the default model used by ZY Code'),
      // 企业级模型白名单
      availableModels: z
        .array(z.string())
        .optional()
        .describe(
          'Allowlist of models that users can select. ' +
            'Accepts tier aliases ("advanced" allows any advanced-tier model), ' +
            'version prefixes, and full model IDs. ' +
            'If undefined, all models are available. If empty array, only the default model is available. ' +
            'Typically set in managed settings by enterprise administrators.',
        ),
      modelOverrides: z
        .record(z.string(), z.string())
        .optional()
        .describe(
          'Override mapping from Anthropic model ID (e.g. "qwen3.6-plus") to provider-specific ' +
            'model ID (e.g. a Bedrock inference profile ARN). Typically set in managed settings by ' +
            'enterprise administrators.',
        ),
      // 用户为模型选择器定义的自定义模型
      customModels: z
        .array(
          z.object({
            alias: z
              .string()
              .describe(
                'Short alias for the model (e.g., "qwen-max", "glm-4"). Used as the settings value.',
              ),
            model: z
              .string()
              .describe('Actual model ID sent to the API (e.g., "qwen-max-latest", "glm-4-plus").'),
            label: z
              .string()
              .optional()
              .describe('Display name in the model picker. Defaults to alias if not provided.'),
            description: z
              .string()
              .optional()
              .describe('Description shown below the model name in the picker.'),
          }),
        )
        .optional()
        .describe(
          'Custom model definitions for the model picker. When set, these models replace ' +
            'the built-in Zy models in the /model selector. Each entry defines an alias ' +
            '(used in settings), the actual model ID (sent to the API), and display metadata.',
        ),
      // 模型能力配置已迁移至 ~/.zy/model-capabilities.json，settings.json 不再包含此字段
      // 是否自动批准项目中的所有 MCP 服务器
      enableAllProjectMcpServers: z
        .boolean()
        .optional()
        .describe('Whether to automatically approve all MCP servers in the project'),
      // .mcp.json 中已批准的 MCP 服务器列表
      enabledMcpjsonServers: z
        .array(z.string())
        .optional()
        .describe('List of approved MCP servers from .mcp.json'),
      // .mcp.json 中已拒绝的 MCP 服务器列表
      disabledMcpjsonServers: z
        .array(z.string())
        .optional()
        .describe('List of rejected MCP servers from .mcp.json'),
      // 企业级 MCP 服务器白名单
      allowedMcpServers: z
        .array(AllowedMcpServerEntrySchema())
        .optional()
        .describe(
          'Enterprise allowlist of MCP servers that can be used. ' +
            'Applies to all scopes including enterprise servers from managed-mcp.json. ' +
            'If undefined, all servers are allowed. If empty array, no servers are allowed. ' +
            'Denylist takes precedence - if a server is on both lists, it is denied.',
        ),
      // 企业级 MCP 服务器黑名单
      deniedMcpServers: z
        .array(DeniedMcpServerEntrySchema())
        .optional()
        .describe(
          'Enterprise denylist of MCP servers that are explicitly blocked. ' +
            'If a server is on the denylist, it will be blocked across all scopes including enterprise. ' +
            'Denylist takes precedence over allowlist - if a server is on both lists, it is denied.',
        ),
      hooks: HooksSchema()
        .optional()
        .describe('Custom commands to run before/after tool executions'),
      worktree: z
        .object({
          symlinkDirectories: z
            .array(z.string())
            .optional()
            .describe(
              'Directories to symlink from main repository to worktrees to avoid disk bloat. ' +
                'Must be explicitly configured - no directories are symlinked by default. ' +
                'Common examples: "node_modules", ".cache", ".bin"',
            ),
          sparsePaths: z
            .array(z.string())
            .optional()
            .describe(
              'Directories to include when creating worktrees, via git sparse-checkout (cone mode). ' +
                'Dramatically faster in large monorepos — only the listed paths are written to disk.',
            ),
          bgIsolation: z
            .enum(['none', 'full'])
            .optional()
            .describe(
              'Background session isolation mode. "none" allows background sessions to edit the working copy directly. ' +
                '"full" (default) creates a separate worktree for each background session.',
            ),
        })
        .optional()
        .describe('Git worktree configuration for --worktree flag.'),
      // 是否禁用所有 hooks 和 statusLine
      disableAllHooks: z
        .boolean()
        .optional()
        .describe('Disable all hooks and statusLine execution'),
      // 哪个 shell 作为输入框 `!` 的后端（见 docs/design/ps-shell-selection.md §4.2）
      defaultShell: z
        .enum(['bash', 'powershell'])
        .optional()
        .describe(
          'Default shell for input-box ! commands. ' +
            "Defaults to 'bash' on all platforms (no Windows auto-flip).",
        ),
      // 仅运行托管配置（managed-settings.json）中定义的 hooks
      allowManagedHooksOnly: z
        .boolean()
        .optional()
        .describe(
          'When true (and set in managed settings), only hooks from managed settings run. ' +
            'User, project, and local hooks are ignored.',
        ),
      // HTTP hooks 可访问的 URL 模式白名单（遵循 allowedMcpServers 的先例）
      allowedHttpHookUrls: z
        .array(z.string())
        .optional()
        .describe(
          'Allowlist of URL patterns that HTTP hooks may target. ' +
            'Supports * as a wildcard (e.g. "https://hooks.example.com/*"). ' +
            'When set, HTTP hooks with non-matching URLs are blocked. ' +
            'If undefined, all URLs are allowed. If empty array, no HTTP hooks are allowed. ' +
            'Arrays merge across settings sources (same semantics as allowedMcpServers).',
        ),
      // HTTP hooks 可插值到请求头中的环境变量名白名单
      httpHookAllowedEnvVars: z
        .array(z.string())
        .optional()
        .describe(
          'Allowlist of environment variable names HTTP hooks may interpolate into headers. ' +
            "When set, each hook's effective allowedEnvVars is the intersection with this list. " +
            'If undefined, no restriction is applied. ' +
            'Arrays merge across settings sources (same semantics as allowedMcpServers).',
        ),
      // 仅使用托管配置（managed-settings.json）中定义的权限规则
      allowManagedPermissionRulesOnly: z
        .boolean()
        .optional()
        .describe(
          'When true (and set in managed settings), only permission rules (allow/deny/ask) from managed settings are respected. ' +
            'User, project, local, and CLI argument permission rules are ignored.',
        ),
      // 仅从托管配置中读取 MCP 白名单策略
      allowManagedMcpServersOnly: z
        .boolean()
        .optional()
        .describe(
          'When true (and set in managed settings), allowedMcpServers is only read from managed settings. ' +
            'deniedMcpServers still merges from all sources, so users can deny servers for themselves. ' +
            'Users can still add their own MCP servers, but only the admin-defined allowlist applies.',
        ),
      // 强制仅通过插件进行自定义（LinkedIn 通过 GTM 提出的需求）
      strictPluginOnlyCustomization: z
        .preprocess(
          // 前向兼容：丢弃未知的表面名称，这样未来的枚举值
          //（如 'commands'）不会导致 safeParse 失败从而使整个
          // managed-settings 文件被置空（settings.ts:101）。旧客户端上
          // ["skills", "commands"] → ["skills"] → 锁定已知的，忽略未知的。
          // 降级为部分锁定，而非全部解锁。
          (v) =>
            Array.isArray(v)
              ? v.filter((x) => (CUSTOMIZATION_SURFACES as readonly string[]).includes(x))
              : v,
          z.union([z.boolean(), z.array(z.enum(CUSTOMIZATION_SURFACES))]),
        )
        .optional()
        // 非数组的无效值（"skills" 字符串、{object}）会原样通过预处理，
        // 并会导致联合类型验证失败 → 使整个 managed-settings 文件置空。
        // .catch 将该字段降级为 undefined。
        // 降级为该字段解锁，而非全部损坏。Doctor 会标记原始值。
        .catch(undefined)
        .describe(
          'When set in managed settings, blocks non-plugin customization sources for the listed surfaces. ' +
            'Array form locks specific surfaces (e.g. ["skills", "hooks"]); `true` locks all four; `false` is an explicit no-op. ' +
            'Blocked: ~/.zy/{surface}/, .zy/{surface}/ (project), settings.json hooks, .mcp.json. ' +
            'NOT blocked: managed (policySettings) sources, plugin-provided customizations. ' +
            'Composes with strictKnownMarketplaces for end-to-end admin control — plugins gated by ' +
            'marketplace allowlist, everything else blocked here.',
        ),
      // 底部内置状态栏，显示 effort、上下文、模型、token、git 信息
      builtInStatusBar: z
        .object({
          enabled: z.boolean().optional(),
          modules: z
            .array(
              z.object({
                id: z.enum(['directory', 'model', 'context', 'tokens', 'cost', 'memory']),
                visible: z.boolean().optional().default(true),
                icon: z.string().optional().describe('Override icon (1-cell unicode)'),
                color: z
                  .string()
                  .optional()
                  .describe('Override color: a theme token name (e.g. "success")'),
              }),
            )
            .optional()
            .describe(
              'Ordered list of status-bar modules. Array order = render order; modules are dropped from the end when the terminal is too narrow. Edit interactively via /statusline.',
            ),
        })
        .optional()
        // Reject old shape (modules: { directory: bool }) silently — fall back
        // to defaults instead of failing the whole settings parse and nuking
        // unrelated user config. /statusline can then re-customize.
        .catch(undefined)
        .describe(
          'Built-in status bar at the bottom of the screen. Shows effort level, context usage, model name, token usage, and git branch.',
        ),
      // 使用市场优先格式的已启用插件
      enabledPlugins: z
        .record(z.string(), z.union([z.array(z.string()), z.boolean(), z.undefined()]))
        .optional()
        .describe(
          'Enabled plugins using plugin-id@marketplace-id format. Example: { "formatter@anthropic-tools": true }. Also supports extended format with version constraints.',
        ),
      // 此仓库的额外市场（通常用于项目配置）
      extraKnownMarketplaces: z
        .record(z.string(), ExtraKnownMarketplaceSchema())
        .check((ctx) => {
          // 对于配置源，键必须等于 source.name。diffMarketplaces
          // 通过字典键查找已物化的状态；addMarketplaceSource 存储在
          // marketplace.name（对于配置即 source.name）下。不匹配意味着
          // 协调器永远不会收敛 — 每次会话：键查找未命中 →
          // 'missing' → source-idempotency 返回 alreadyMaterialized 但
          // installed++ 继续增加 → 无意义的缓存清除。对于 github/git/url，
          // name 来自获取的 marketplace.json（不匹配是预期的且无害的）；
          // 对于 settings，键和名称都是用户在同一 JSON 对象中编写的。
          for (const [key, entry] of Object.entries(ctx.value)) {
            if (entry.source.source === 'settings' && entry.source.name !== key) {
              ctx.issues.push({
                code: 'custom',
                input: entry.source.name,
                path: [key, 'source', 'name'],
                message:
                  `Settings-sourced marketplace name must match its extraKnownMarketplaces key ` +
                  `(got key "${key}" but source.name "${entry.source.name}")`,
              })
            }
          }
        })
        .optional()
        .describe(
          'Additional marketplaces to make available for this repository. Typically used in repository .zy/settings.json to ensure team members have required plugin sources.',
        ),
      // 企业级严格的允许市场源列表（仅策略配置）
      // 设置后，只有这些确切的源可以被添加。检查在下载之前进行。
      strictKnownMarketplaces: z
        .array(MarketplaceSourceSchema())
        .optional()
        .describe(
          'Enterprise strict list of allowed marketplace sources. When set in managed settings, ' +
            'ONLY these exact sources can be added as marketplaces. The check happens BEFORE ' +
            'downloading, so blocked sources never touch the filesystem. ' +
            'Note: this is a policy gate only — it does NOT register marketplaces. ' +
            'To pre-register allowed marketplaces for users, also set extraKnownMarketplaces.',
        ),
      // 企业级市场源黑名单（仅策略配置）
      // 设置后，这些确切的源会被阻止。检查在下载之前进行。
      blockedMarketplaces: z
        .array(MarketplaceSourceSchema())
        .optional()
        .describe(
          'Enterprise blocklist of marketplace sources. When set in managed settings, ' +
            'these exact sources are blocked from being added as marketplaces. The check happens BEFORE ' +
            'downloading, so blocked sources never touch the filesystem.',
        ),
      // 强制使用特定的登录方式：'zyai' 用于 Zy Pro/Max，'console' 用于 Console 计费
      forceLoginMethod: z
        .enum(['zyai', 'console'])
        .optional()
        .describe(
          'Force a specific login method: "zyai" for Zy Pro/Max, "console" for Console billing',
        ),
      // OAuth 登录时使用的组织 UUID（将作为 URL 参数添加到授权 URL）
      forceLoginOrgUUID: z.string().optional().describe('Organization UUID to use for OAuth login'),
      otelHeadersHelper: z
        .string()
        .optional()
        .describe('Path to a script that outputs OpenTelemetry headers'),
      outputStyle: z
        .string()
        .optional()
        .describe('Controls the output style for assistant responses'),
      language: z
        .string()
        .optional()
        .describe(
          'Preferred language for Zy responses and voice dictation (e.g., "Chinese", "Japanese", "Español"). Also controls UI text language.',
        ),
      skipWebFetchPreflight: z
        .boolean()
        .optional()
        .describe(
          'Skip the WebFetch blocklist check for enterprise environments with restrictive security policies',
        ),
      sandbox: SandboxSettingsSchema().optional(),
      feedbackSurveyRate: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe(
          'Probability (0–1) that the session quality survey appears when eligible. 0.05 is a reasonable starting point.',
        ),
      spinnerTipsEnabled: z.boolean().optional().describe('Whether to show tips in the spinner'),
      spinnerVerbs: z
        .object({
          mode: z.enum(['append', 'replace']),
          verbs: z.array(z.string()),
        })
        .optional()
        .describe(
          'Customize spinner verbs. mode: "append" adds verbs to defaults, "replace" uses only your verbs.',
        ),
      spinnerTipsOverride: z
        .object({
          excludeDefault: z.boolean().optional(),
          tips: z.array(z.string()),
        })
        .optional()
        .describe(
          'Override spinner tips. tips: array of tip strings. excludeDefault: if true, only show custom tips (default: false).',
        ),
      syntaxHighlightingDisabled: z
        .boolean()
        .optional()
        .describe('Whether to disable syntax highlighting in diffs'),
      terminalTitleFromRename: z
        .boolean()
        .optional()
        .describe(
          'Whether /rename updates the terminal tab title (defaults to true). Set to false to keep auto-generated topic titles.',
        ),
      alwaysThinkingEnabled: z
        .boolean()
        .optional()
        .describe(
          'When false, thinking is disabled. When absent or true, thinking is ' +
            'enabled automatically for supported models.',
        ),
      defaultMaxOutputTokenRatio: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe(
          "Ratio (0–1) for calculating the default max output tokens from the model's " +
            'maxOutputTokens. The default request uses min(maxOutputTokens * ratio, minDefaultMaxOutputTokens). ' +
            'If the response gets truncated, it retries with the full maxOutputTokens as upper limit. ' +
            'Defaults to 0.75.',
        ),
      minDefaultMaxOutputTokens: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          'Upper bound (cap) for the default max output tokens per request. ' +
            'The effective default is min(maxOutputTokens * defaultMaxOutputTokenRatio, minDefaultMaxOutputTokens). ' +
            'Defaults to 8000.',
        ),
      effortLevel: z
        .enum(isInternalBuild() ? ['low', 'medium', 'high', 'max'] : ['low', 'medium', 'high'])
        .optional()
        .catch(undefined)
        .describe('Persisted effort level for supported models.'),
      advisorModel: z
        .string()
        .optional()
        .describe('Advisor model for the server-side advisor tool.'),
      promptSuggestionEnabled: z
        .boolean()
        .optional()
        .describe(
          'When false, prompt suggestions are disabled. When absent or true, ' +
            'prompt suggestions are enabled.',
        ),
      promptCacheTTL: z
        .enum(['5m', '1h'])
        .optional()
        .describe(
          'TTL for prompt cache entries. Options: "5m" (5 minutes, default) or "1h" (1 hour). ' +
            'Longer TTL improves cache hit rates but uses more storage. ' +
            'Applies to Anthropic and OpenAI APIs that support prompt caching.',
        ),
      showClearContextOnPlanAccept: z
        .boolean()
        .optional()
        .describe(
          'When true, the plan-approval dialog offers a "clear context" option. Defaults to false.',
        ),
      agent: z
        .string()
        .optional()
        .describe(
          'Name of an agent (built-in or custom) to use for the main thread. ' +
            "Applies the agent's system prompt, tool restrictions, and model.",
        ),
      companyAnnouncements: z
        .array(z.string())
        .optional()
        .describe(
          'Company announcements to display at startup (one will be randomly selected if multiple are provided)',
        ),
      pluginConfigs: z
        .record(
          z.string(),
          z.object({
            mcpServers: z
              .record(
                z.string(),
                z.record(
                  z.string(),
                  z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
                ),
              )
              .optional()
              .describe('User configuration values for MCP servers keyed by server name'),
            options: z
              .record(
                z.string(),
                z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
              )
              .optional()
              .describe(
                'Non-sensitive option values from plugin manifest userConfig, keyed by option name. Sensitive values go to secure storage instead.',
              ),
          }),
        )
        .optional()
        .describe(
          'Per-plugin configuration including MCP server user configs, keyed by plugin ID (plugin@marketplace format)',
        ),
      remote: z
        .object({
          defaultEnvironmentId: z
            .string()
            .optional()
            .describe('Default environment ID to use for remote sessions'),
        })
        .optional()
        .describe('Remote session configuration'),
      autoUpdatesChannel: z
        .enum(['latest', 'stable'])
        .optional()
        .describe('Release channel for auto-updates (latest or stable)'),
      ...(feature('LODESTONE')
        ? {
            disableDeepLinkRegistration: z
              .enum(['disable'])
              .optional()
              .describe('Prevent zy-cli:// protocol handler registration with the OS'),
          }
        : {}),
      minimumVersion: z
        .string()
        .optional()
        .describe(
          'Minimum version to stay on - prevents downgrades when switching to stable channel',
        ),
      plansDirectory: z
        .string()
        .optional()
        .describe(
          'Custom directory for plan files, relative to project root. ' +
            'If not set, defaults to ~/.zy/plans/',
        ),
      ...(isInternalBuild()
        ? {
            classifierPermissionsEnabled: z
              .boolean()
              .optional()
              .describe('Enable AI-based classification for Bash(prompt:...) permission rules'),
          }
        : {}),
      ...(feature('PROACTIVE') || feature('KAIROS')
        ? {
            minSleepDurationMs: z
              .number()
              .nonnegative()
              .int()
              .optional()
              .describe(
                'Minimum duration in milliseconds that the Sleep tool must sleep for. ' +
                  'Useful for throttling proactive tick frequency.',
              ),
            maxSleepDurationMs: z
              .number()
              .int()
              .min(-1)
              .optional()
              .describe(
                'Maximum duration in milliseconds that the Sleep tool can sleep for. ' +
                  'Set to -1 for indefinite sleep (waits for user input). ' +
                  'Useful for limiting idle time in remote/managed environments.',
              ),
          }
        : {}),
      ...(feature('VOICE_MODE')
        ? {
            voiceEnabled: z
              .boolean()
              .optional()
              .describe('Enable voice mode (hold-to-talk dictation)'),
          }
        : {}),
      ...(feature('KAIROS')
        ? {
            assistant: z
              .boolean()
              .optional()
              .describe(
                'Start ZY in assistant mode (custom system prompt, brief view, scheduled check-in skills)',
              ),
            assistantName: z
              .string()
              .optional()
              .describe('Display name for the assistant, shown in the zy.ai session list'),
          }
        : {}),
      // 团队/企业选择启用频道通知。默认关闭。
      // 声明了 zy/channel 能力的 MCP 服务器可以将入站消息推送到对话中；
      // 对于托管组织，这只有在明确启用时才会生效。哪些服务器可以连接
      // 仍由 allowedMcpServers/deniedMcpServers 管控。不使用 feature-spread：
      // KAIROS_CHANNELS 是 external:true，spread 会破坏 allowedChannelPlugins
      // 的类型推断（.passthrough() 全捕获给出 {} 而非数组类型）。
      channelsEnabled: z
        .boolean()
        .optional()
        .describe(
          'Teams/Enterprise opt-in for channel notifications (MCP servers with the ' +
            'zy/channel capability pushing inbound messages). Default off. ' +
            'Set true to allow; users then select servers via --channels.',
        ),
      // 组织级频道插件白名单。设置后，替换 Anthropic 名册 -
      // 管理员拥有信任决策权。undefined 表示回退到名册。
      // 仅插件条目形态（与名册相同）；服务器类型条目仍需要开发标志。
      allowedChannelPlugins: z
        .array(
          z.object({
            marketplace: z.string(),
            plugin: z.string(),
          }),
        )
        .optional()
        .describe(
          'Teams/Enterprise allowlist of channel plugins. When set, ' +
            'replaces the default Anthropic allowlist — admins decide which ' +
            'plugins may push inbound messages. Undefined falls back to the default. ' +
            'Requires channelsEnabled: true.',
        ),
      ...(feature('KAIROS') || feature('KAIROS_BRIEF')
        ? {
            defaultView: z
              .enum(['chat', 'transcript'])
              .optional()
              .describe(
                'Default transcript view: chat (SendUserMessage checkpoints only) or transcript (full)',
              ),
          }
        : {}),
      prefersReducedMotion: z
        .boolean()
        .optional()
        .describe(
          'Reduce or disable animations for accessibility (spinner shimmer, flash effects, etc.)',
        ),
      autoMemoryEnabled: z
        .boolean()
        .optional()
        .describe(
          'Enable auto-memory for this project. When false, Zy will not read from or write to the auto-memory directory.',
        ),
      autoMemoryDirectory: z
        .string()
        .optional()
        .describe(
          'Custom directory path for auto-memory storage. Supports ~/ prefix for home directory expansion. Ignored if set in projectSettings (checked-in .zy/settings.json) for security. When unset, defaults to ~/.zy/projects/<sanitized-cwd>/memory/.',
        ),
      autoDreamEnabled: z
        .boolean()
        .optional()
        .describe(
          'Enable background memory consolidation (auto-dream). When set, overrides the server-side default.',
        ),
      showThinkingSummaries: z
        .boolean()
        .optional()
        .describe('Show thinking summaries in the transcript view (ctrl+o). Default: false.'),
      skipDangerousModePermissionPrompt: z
        .boolean()
        .optional()
        .describe('Whether the user has accepted the bypass permissions mode dialog'),
      ...(feature('TRANSCRIPT_CLASSIFIER')
        ? {
            skipAutoPermissionPrompt: z
              .boolean()
              .optional()
              .describe('Whether the user has accepted the auto mode opt-in dialog'),
            useAutoModeDuringPlan: z
              .boolean()
              .optional()
              .describe(
                'Whether plan mode uses auto mode semantics when auto mode is available (default: true)',
              ),
            autoMode: z
              .object({
                allow: z
                  .array(z.string())
                  .optional()
                  .describe('Rules for the auto mode classifier allow section'),
                soft_deny: z
                  .array(z.string())
                  .optional()
                  .describe('Rules for the auto mode classifier deny section'),
                ...(isInternalBuild()
                  ? {
                      // 向后兼容别名；外部用户使用 soft_deny
                      deny: z.array(z.string()).optional(),
                    }
                  : {}),
                environment: z
                  .array(z.string())
                  .optional()
                  .describe('Entries for the auto mode classifier environment section'),
              })
              .optional()
              .describe('Auto mode classifier prompt customization'),
          }
        : {}),
      disableAutoMode: z.enum(['disable']).optional().describe('Disable auto mode'),
      disableSkillShellExecution: z
        .boolean()
        .optional()
        .describe(
          'When true, inline shell execution in skills, custom slash commands and plugin commands is disabled',
        ),
      sshConfigs: z
        .array(
          z.object({
            id: z
              .string()
              .describe(
                'Unique identifier for this SSH config. Used to match configs across settings sources.',
              ),
            name: z.string().describe('Display name for the SSH connection'),
            sshHost: z
              .string()
              .describe(
                'SSH host in format "user@hostname" or "hostname", or a host alias from ~/.ssh/config',
              ),
            sshPort: z.number().int().optional().describe('SSH port (default: 22)'),
            sshIdentityFile: z
              .string()
              .optional()
              .describe('Path to SSH identity file (private key)'),
            startDirectory: z
              .string()
              .optional()
              .describe(
                'Default working directory on the remote host. ' +
                  'Supports tilde expansion (e.g. ~/projects). ' +
                  'If not specified, defaults to the remote user home directory. ' +
                  'Can be overridden by the [dir] positional argument in `zy ssh <config> [dir]`.',
              ),
          }),
        )
        .optional()
        .describe(
          'SSH connection configurations for remote environments. ' +
            'Typically set in managed settings by enterprise administrators ' +
            'to pre-configure SSH connections for team members.',
        ),
      agentsMdExcludes: z
        .array(z.string())
        .optional()
        .describe(
          'Glob patterns or absolute paths of AGENTS.md files to exclude from loading. ' +
            'Patterns are matched against absolute file paths using picomatch. ' +
            'Only applies to User, Project, and Local memory types (Managed/policy files cannot be excluded). ' +
            'Examples: "/home/user/monorepo/AGENTS.md", "**/code/AGENTS.md", "**/some-dir/.zy/rules/**"',
        ),
      pluginTrustMessage: z
        .string()
        .optional()
        .describe(
          'Custom message to append to the plugin trust warning shown before installation. ' +
            'Only read from policy settings (managed-settings.json / MDM). ' +
            'Useful for enterprise administrators to add organization-specific context ' +
            '(e.g., "All plugins from our internal marketplace are vetted and approved.").',
        ),
      webSearch: z
        .object({
          region: z
            .string()
            .optional()
            .describe(
              'Region code for the DuckDuckGo fallback search (e.g., "us-en", "zh-cn"). ' +
                'Most providers (dashscope, openai) use native API-level web search and ignore this. ' +
                'Only applies when falling back to DuckDuckGo Lite.',
            ),
        })
        .optional()
        .describe(
          'Web search fallback configuration. Native API search (dashscope/openai) is used automatically when available.',
        ),
    })
    .passthrough(),
)

/**
 * 插件 hooks 的内部类型 - 包含执行时的插件上下文。
 * 非 Zod schema，因为它不面向用户（插件提供原生 hooks）。
 */
export type PluginHookMatcher = {
  matcher?: string
  hooks: HookCommand[]
  pluginRoot: string
  pluginName: string
  pluginId: string // 格式："pluginName@marketplaceName"
}

/**
 * Skill hooks 的内部类型 - 包含执行时的 skill 上下文。
 * 非 Zod schema，因为它不面向用户（skills 提供原生 hooks）。
 */
export type SkillHookMatcher = {
  matcher?: string
  hooks: HookCommand[]
  skillRoot: string
  skillName: string
}

export type AllowedMcpServerEntry = z.infer<ReturnType<typeof AllowedMcpServerEntrySchema>>
export type DeniedMcpServerEntry = z.infer<ReturnType<typeof DeniedMcpServerEntrySchema>>
export type SettingsJson = z.infer<ReturnType<typeof SettingsSchema>>

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

/**
 * MCPB MCP 服务器的用户配置值
 */
export type UserConfigValues = Record<string, string | number | boolean | string[]>

/**
 * 存储在 settings.json 中的插件配置
 */
export type PluginConfig = {
  mcpServers?: {
    [serverName: string]: UserConfigValues
  }
}
