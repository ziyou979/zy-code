import { z } from 'zod/v4'
import { HooksSchema } from '../../schemas/hooks.js'
import { McpServerConfigSchema } from '../mcp/types.js'
import { lazySchema } from '../../utils/lazySchema.js'

/**
 * 抵御官方市场仿冒的第一层防御。
 *
 * 此验证阻止直接仿冒尝试，如 "zy-code-official"、
 * "zy-marketplace" 等。故意不阻止间接变体
 *（例如 "my-zy-marketplace"）以避免误杀合法名称。
 * 源组织验证在注册/安装时提供额外保护。
 */

/**
 * 保留给 ZY/ZY Code 官方使用的官方市场名称。
 * 这些名称仅允许用于官方市场，第三方被阻止。
 */
export const ALLOWED_OFFICIAL_MARKETPLACE_NAMES = new Set([
  'zy-code-marketplace',
  'zy-code-plugins',
  'zy-plugins-official',
  'anthropic-marketplace',
  'anthropic-plugins',
  'agent-skills',
  'life-sciences',
  'knowledge-work-plugins',
])

/**
 * 默认不自动更新的官方市场。
 * 这些仍然是保留/允许的名称，但选择不参与
 * 其他官方市场收到的自动更新默认值。
 */
const NO_AUTO_UPDATE_OFFICIAL_MARKETPLACES = new Set(['knowledge-work-plugins'])

/**
 * 检查市场是否启用自动更新。
 * 如果已设置则使用存储的值，否则默认为是否
 * 是官方 Anthropic 市场（true）或不是（false）。
 * NO_AUTO_UPDATE_OFFICIAL_MARKETPLACES 中的官方市场被排除
 * 在自动更新默认值之外。
 *
 * @param marketplaceName - 市场名称
 * @param entry - 市场条目（可能设置了 autoUpdate）
 * @returns 此市场是否启用自动更新
 */
export function isMarketplaceAutoUpdate(
  marketplaceName: string,
  entry: { autoUpdate?: boolean },
): boolean {
  const normalizedName = marketplaceName.toLowerCase()
  return (
    entry.autoUpdate ??
    (ALLOWED_OFFICIAL_MARKETPLACE_NAMES.has(normalizedName) &&
      !NO_AUTO_UPDATE_OFFICIAL_MARKETPLACES.has(normalizedName))
  )
}

/**
 * 检测仿冒官方 Anthropic/ZY 市场的名称模式。
 *
 * 匹配如下变体的名称：
 * - "official" 与 "anthropic" 或 "zy" 组合（例如 "official-zy-plugins"）
 * - "anthropic" 或 "zy" 与 "official" 组合（例如 "zy-official"）
 * - 以 "anthropic" 或 "zy" 开头，后跟官方风格术语
 *   如 "marketplace"、"plugins"（例如 "anthropic-marketplace-new"、"zy-plugins-v2"）
 *
 * 该模式不区分大小写。
 */
export const BLOCKED_OFFICIAL_NAME_PATTERN =
  /(?:official[^a-z0-9]*(anthropic|zy)|(?:anthropic|zy)[^a-z0-9]*official|^(?:anthropic|zy)[^a-z0-9]*(marketplace|plugins|official))/i

/**
 * 检测可能用于同形异义攻击的非 ASCII 字符的模式。
 * 市场名称只能包含 ASCII 字符，以防止
 * 通过类似 Unicode 字符进行仿冒（例如用西里尔字母 'а' 代替拉丁字母 'a'）。
 */
const NON_ASCII_PATTERN = /[^\u0020-\u007E]/

/**
 * 检查市场名称是否仿冒官方 ZY/ZY Code 市场。
 *
 * @param name - 要检查的市场名称
 * @returns 如果名称被阻止（仿冒官方）则为 true，否则为 false
 */
export function isBlockedOfficialName(name: string): boolean {
  // 如果在允许列表中，则不被阻止
  if (ALLOWED_OFFICIAL_MARKETPLACE_NAMES.has(name.toLowerCase())) {
    return false
  }

  // 阻止包含非 ASCII 字符的名称以防止同形异义攻击
  //（例如使用西里尔字母 'а' 仿冒 'anthropic'）
  if (NON_ASCII_PATTERN.test(name)) {
    return true
  }

  // 检查是否匹配被阻止的模式
  return BLOCKED_OFFICIAL_NAME_PATTERN.test(name)
}

/**
 * ZY 市场的官方 GitHub 组织。
 * 保留名称必须来自此组织。
 */
export const OFFICIAL_GITHUB_ORG = 'anthropics'

/**
 * 验证具有保留名称的市场来自官方源。
 *
 * 保留名称（在 ALLOWED_OFFICIAL_MARKETPLACE_NAMES 中）只能由
 * 来自官方 ZY GitHub 组织的市场使用。
 *
 * @param name - 市场名称
 * @param source - 市场源配置
 * @returns 如果验证失败则返回错误消息，有效则返回 null
 */
export function validateOfficialNameSource(
  name: string,
  source: { source: string; repo?: string; url?: string },
): string | null {
  const normalizedName = name.toLowerCase()

  // 仅验证保留名称
  if (!ALLOWED_OFFICIAL_MARKETPLACE_NAMES.has(normalizedName)) {
    return null // 不是保留名称，无需源验证
  }

  // 检查 GitHub 源类型
  if (source.source === 'github') {
    // 验证仓库来自官方组织
    const repo = source.repo || ''
    if (!repo.toLowerCase().startsWith(`${OFFICIAL_GITHUB_ORG}/`)) {
      return `The name '${name}' is reserved for official Anthropic marketplaces. Only repositories from 'github.com/${OFFICIAL_GITHUB_ORG}/' can use this name.`
    }
    return null // 有效：来自官方 GitHub 源的保留名称
  }

  // 检查 git URL 源类型
  if (source.source === 'git' && source.url) {
    const url = source.url.toLowerCase()
    // 检查 HTTPS URL 格式：https://github.com/anthropics/...
    // 或 SSH 格式：git@github.com:anthropics/...
    const isHttpsAnthropics = url.includes('github.com/anthropics/')
    const isSshAnthropics = url.includes('git@github.com:anthropics/')

    if (isHttpsAnthropics || isSshAnthropics) {
      return null // 有效：来自官方 git URL 的保留名称
    }

    return `The name '${name}' is reserved for official Anthropic marketplaces. Only repositories from 'github.com/${OFFICIAL_GITHUB_ORG}/' can use this name.`
  }

  // 保留名称必须来自 GitHub（'github' 或 'git' 源）
  return `The name '${name}' is reserved for official Anthropic marketplaces and can only be used with GitHub sources from the '${OFFICIAL_GITHUB_ORG}' organization.`
}

/**
 * 以 './' 开头的相对文件路径的 Schema
 */
const RelativePath = lazySchema(() => z.string().startsWith('./'))

/**
 * JSON 文件相对路径的 Schema
 */
const RelativeJSONPath = lazySchema(() => RelativePath().endsWith('.json'))

/**
 * MCPB（MCP Bundle）文件路径的 Schema
 * 支持本地相对路径和远程 URL
 */
const McpbPath = lazySchema(() =>
  z.union([
    RelativePath()
      .refine((path) => path.endsWith('.mcpb') || path.endsWith('.dxt'), {
        message: 'MCPB file path must end with .mcpb or .dxt',
      })
      .describe('Path to MCPB file relative to plugin root'),
    z
      .string()
      .url()
      .refine((url) => url.endsWith('.mcpb') || url.endsWith('.dxt'), {
        message: 'MCPB URL must end with .mcpb or .dxt',
      })
      .describe('URL to MCPB file'),
  ]),
)

/**
 * Markdown 文件相对路径的 Schema
 */
const RelativeMarkdownPath = lazySchema(() => RelativePath().endsWith('.md'))

/**
 * 命令源相对路径的 Schema（markdown 文件或包含 SKILL.md 的目录）
 */
const RelativeCommandPath = lazySchema(() =>
  z.union([
    RelativeMarkdownPath(),
    RelativePath(), // 允许任何相对路径，包括目录
  ]),
)

/**
 * 共享的市场名称验证。PluginMarketplaceSchema
 *（验证已获取的 marketplace.json）和设置的
 * MarketplaceSourceSchema（验证 settings.json 中的内联名称）都使用。
 *
 * 两者必须保持同步：loadAndCacheMarketplace 的 case 'settings' 在
 * 后写入 PluginMarketplaceSchema 验证运行之前写入
 * join(cacheDir, source.name)。任何通过设置臂但失败
 * PluginMarketplaceSchema 的名称都会在缓存中留下孤儿文件（cleanupNeeded=false）。
 * 使用单个共享 Schema 使漂移成为不可能。
 */
const MarketplaceNameSchema = lazySchema(() =>
  z
    .string()
    .min(1, 'Marketplace must have a name')
    .refine((name) => !name.includes(' '), {
      message: 'Marketplace name cannot contain spaces. Use kebab-case (e.g., "my-marketplace")',
    })
    .refine(
      (name) => !name.includes('/') && !name.includes('\\') && !name.includes('..') && name !== '.',
      {
        message:
          'Marketplace name cannot contain path separators (/ or \\), ".." sequences, or be "."',
      },
    )
    .refine((name) => !isBlockedOfficialName(name), {
      message: 'Marketplace name impersonates an official Anthropic/Zy marketplace',
    })
    .refine((name) => name.toLowerCase() !== 'inline', {
      message: 'Marketplace name "inline" is reserved for --plugin-dir session plugins',
    })
    .refine((name) => name.toLowerCase() !== 'builtin', {
      message: 'Marketplace name "builtin" is reserved for built-in plugins',
    }),
)

/**
 * 插件作者信息的 Schema
 */
export const PluginAuthorSchema = lazySchema(() =>
  z.object({
    name: z
      .string()
      .min(1, 'Author name cannot be empty')
      .describe('Display name of the plugin author or organization'),
    email: z.string().optional().describe('Contact email for support or feedback'),
    url: z.string().optional().describe('Website, GitHub profile, or organization URL'),
  }),
)

/**
 * 插件清单文件（plugin.json）的元数据部分
 *
 * 此 Schema 验证插件清单的结构，并在从磁盘加载插件时提供
 * 运行时类型检查。
 */
const PluginManifestMetadataSchema = lazySchema(() =>
  z.object({
    name: z
      .string()
      .min(1, 'Plugin name cannot be empty')
      .refine((name) => !name.includes(' '), {
        message: 'Plugin name cannot contain spaces. Use kebab-case (e.g., "my-plugin")',
      })
      .describe('Unique identifier for the plugin, used for namespacing (prefer kebab-case)'),
    version: z
      .string()
      .optional()
      .describe('Semantic version (e.g., 1.2.3) following semver.org specification'),
    description: z
      .string()
      .optional()
      .describe('Brief, user-facing explanation of what the plugin provides'),
    author: PluginAuthorSchema()
      .optional()
      .describe('Information about the plugin creator or maintainer'),
    homepage: z.string().url().optional().describe('Plugin homepage or documentation URL'),
    repository: z.string().optional().describe('Source code repository URL'),
    license: z.string().optional().describe('SPDX license identifier (e.g., MIT, Apache-2.0)'),
    keywords: z
      .array(z.string())
      .optional()
      .describe('Tags for plugin discovery and categorization'),
    dependencies: z
      .array(DependencyRefSchema())
      .optional()
      .describe(
        'Plugins that must be enabled for this plugin to function. Bare names (no "@marketplace") are resolved against the declaring plugin\'s own marketplace.',
      ),
  }),
)

/**
 * 插件钩子配置（hooks.json）的 Schema
 *
 * 定义插件可以提供的钩子，用于在各种生命周期事件中拦截和修改
 * ZY Code 行为。
 */
export const PluginHooksSchema = lazySchema(() =>
  z.object({
    description: z
      .string()
      .optional()
      .describe('Brief, user-facing explanation of what these hooks provide'),
    hooks: z
      .lazy(() => HooksSchema())
      .describe(
        'The hooks provided by the plugin, in the same format as the one used for settings',
      ),
  }),
)

/**
 * 插件清单中额外钩子配置的 Schema
 *
 * 允许插件以内联或通过外部文件指定钩子，
 * 补充标准 hooks/hooks.json 位置中定义的任何钩子。
 */
const PluginManifestHooksSchema = lazySchema(() =>
  z.object({
    hooks: z.union([
      RelativeJSONPath().describe(
        'Path to file with additional hooks (in addition to those in hooks/hooks.json, if it exists), relative to the plugin root',
      ),
      z
        .lazy(() => HooksSchema())
        .describe('Additional hooks (in addition to those in hooks/hooks.json, if it exists)'),
      z.array(
        z.union([
          RelativeJSONPath().describe(
            'Path to file with additional hooks (in addition to those in hooks/hooks.json, if it exists), relative to the plugin root',
          ),
          z
            .lazy(() => HooksSchema())
            .describe('Additional hooks (in addition to those in hooks/hooks.json, if it exists)'),
        ]),
      ),
    ]),
  }),
)

/**
 * 使用对象映射格式时命令元数据的 Schema
 *
 * 允许市场条目为命令提供丰富的元数据，包括
 * 自定义描述和 frontmatter 覆盖。
 *
 * 命令可以使用以下任一格式定义：
 * - source：指向 markdown 文件的路径
 * - content：内联 markdown 内容
 */
export const CommandMetadataSchema = lazySchema(() =>
  z
    .object({
      source: RelativeCommandPath()
        .optional()
        .describe('Path to command markdown file, relative to plugin root'),
      content: z.string().optional().describe('Inline markdown content for the command'),
      description: z.string().optional().describe('Command description override'),
      argumentHint: z.string().optional().describe('Hint for command arguments (e.g., "[file]")'),
      model: z.string().optional().describe('Default model for this command'),
      allowedTools: z.array(z.string()).optional().describe('Tools allowed when command runs'),
    })
    .refine((data) => (data.source && !data.content) || (!data.source && data.content), {
      message:
        'Command must have either "source" (file path) or "content" (inline markdown), but not both',
    }),
)

/**
 * 插件清单中额外命令定义的 Schema
 *
 * 允许插件指定标准 commands/ 目录之外的额外命令文件或技能目录。
 *
 * 支持三种格式：
 * 1. 单个路径："./README.md"
 * 2. 路径数组：["./README.md", "./docs/guide.md"]
 * 3. 对象映射：{ "about": { "source": "./README.md", "description": "..." } }
 */
const PluginManifestCommandsSchema = lazySchema(() =>
  z.object({
    commands: z.union([
      // TODO（未来工作）：允许通配符？
      RelativeCommandPath().describe(
        'Path to additional command file or skill directory (in addition to those in the commands/ directory, if it exists), relative to the plugin root',
      ),
      z
        .array(
          RelativeCommandPath().describe(
            'Path to additional command file or skill directory (in addition to those in the commands/ directory, if it exists), relative to the plugin root',
          ),
        )
        .describe('List of paths to additional command files or skill directories'),
      z
        .record(z.string(), CommandMetadataSchema())
        .describe(
          'Object mapping of command names to their metadata and source files. Command name becomes the slash command name (e.g., "about" → "/plugin:about")',
        ),
    ]),
  }),
)

/**
 * 插件清单中额外 agent 定义的 Schema
 *
 * 允许插件指定标准 agents/ 目录之外的额外 agent 文件。
 */
const PluginManifestAgentsSchema = lazySchema(() =>
  z.object({
    agents: z.union([
      // TODO（未来工作）：允许通配符？
      RelativeMarkdownPath().describe(
        'Path to additional agent file (in addition to those in the agents/ directory, if it exists), relative to the plugin root',
      ),
      z
        .array(
          RelativeMarkdownPath().describe(
            'Path to additional agent file (in addition to those in the agents/ directory, if it exists), relative to the plugin root',
          ),
        )
        .describe('List of paths to additional agent files'),
    ]),
  }),
)

/**
 * 插件清单中额外技能定义的 Schema
 *
 * 允许插件指定标准 skills/ 目录之外的额外技能目录。
 */
const PluginManifestSkillsSchema = lazySchema(() =>
  z.object({
    skills: z.union([
      RelativePath().describe(
        'Path to additional skill directory (in addition to those in the skills/ directory, if it exists), relative to the plugin root',
      ),
      z
        .array(
          RelativePath().describe(
            'Path to additional skill directory (in addition to those in the skills/ directory, if it exists), relative to the plugin root',
          ),
        )
        .describe('List of paths to additional skill directories'),
    ]),
  }),
)

/**
 * 插件清单中额外输出样式定义的 Schema
 *
 * 允许插件指定标准 output-styles/ 目录之外的额外输出样式文件或目录。
 */
const PluginManifestOutputStylesSchema = lazySchema(() =>
  z.object({
    outputStyles: z.union([
      RelativePath().describe(
        'Path to additional output styles directory or file (in addition to those in the output-styles/ directory, if it exists), relative to the plugin root',
      ),
      z
        .array(
          RelativePath().describe(
            'Path to additional output styles directory or file (in addition to those in the output-styles/ directory, if it exists), relative to the plugin root',
          ),
        )
        .describe('List of paths to additional output styles directories or files'),
    ]),
  }),
)

// LSP 配置的辅助验证器
const nonEmptyString = lazySchema(() => z.string().min(1))
const fileExtension = lazySchema(() =>
  z
    .string()
    .min(2)
    .refine((ext) => ext.startsWith('.'), {
      message: 'File extensions must start with dot (e.g., ".ts", not "ts")',
    }),
)

/**
 * 插件清单中 MCP 服务器配置的 Schema
 *
 * 允许插件以内联或通过外部配置文件提供 MCP 服务器，
 * 补充 .mcp.json 中的任何服务器。
 */
const PluginManifestMcpServerSchema = lazySchema(() =>
  z.object({
    mcpServers: z.union([
      RelativeJSONPath().describe(
        'MCP servers to include in the plugin (in addition to those in the .mcp.json file, if it exists)',
      ),
      McpbPath().describe('Path or URL to MCPB file containing MCP server configuration'),
      z
        .record(z.string(), McpServerConfigSchema())
        .describe('MCP server configurations keyed by server name'),
      z
        .array(
          z.union([
            RelativeJSONPath().describe('Path to MCP servers configuration file'),
            McpbPath().describe('Path or URL to MCPB file'),
            z
              .record(z.string(), McpServerConfigSchema())
              .describe('Inline MCP server configurations'),
          ]),
        )
        .describe('Array of MCP server configurations (paths, MCPB files, or inline definitions)'),
    ]),
  }),
)

/**
 * 插件清单 userConfig 中单个用户可配置选项的 Schema。
 *
 * 形状有意匹配 `@anthropic-ai/mcpb` 中的 `McpbUserConfigurationOption`，
 * 因此解析结果可以结构赋值给 mcpbHandler.ts 中的
 * `UserConfigSchema` — 这让我们可以复用
 * `validateUserConfig` 和配置对话框而无需修改。
 * `title` 和 `description` 是必填的（而非可选），因为上游
 * 类型需要它们且配置对话框会渲染它们。
 *
 * 用于顶层 manifest.userConfig 和每个频道的
 * channels[].userConfig（助手模式频道）。
 */
const PluginUserConfigOptionSchema = lazySchema(() =>
  z
    .object({
      type: z
        .enum(['string', 'number', 'boolean', 'directory', 'file'])
        .describe('Type of the configuration value'),
      title: z.string().describe('Human-readable label shown in the config dialog'),
      description: z.string().describe('Help text shown beneath the field in the config dialog'),
      required: z
        .boolean()
        .optional()
        .describe('If true, validation fails when this field is empty'),
      default: z
        .union([z.string(), z.number(), z.boolean(), z.array(z.string())])
        .optional()
        .describe('Default value used when the user provides nothing'),
      multiple: z.boolean().optional().describe('For string type: allow an array of strings'),
      sensitive: z
        .boolean()
        .optional()
        .describe(
          'If true, masks dialog input and stores value in secure storage (keychain/credentials file) instead of settings.json',
        ),
      min: z.number().optional().describe('Minimum value (number type only)'),
      max: z.number().optional().describe('Maximum value (number type only)'),
    })
    .strict(),
)

/**
 * 插件清单中顶层 userConfig 字段的 Schema。
 *
 * 声明插件需要的用户可配置值。用户在启用时被提示。
 * 非敏感值存入 settings.json pluginConfigs[pluginId].options；
 * 敏感值存入安全存储。值可在 MCP/LSP 服务器配置、钩子
 * 命令和（仅非敏感）技能/agent 内容中作为 ${user_config.KEY} 使用。
 */
const PluginManifestUserConfigSchema = lazySchema(() =>
  z.object({
    userConfig: z
      .record(
        z
          .string()
          .regex(
            /^[A-Za-z_]\w*$/,
            'Option keys must be valid identifiers (letters, digits, underscore; no leading digit) — they become CLAUDE_PLUGIN_OPTION_<KEY> env vars in hooks',
          ),
        PluginUserConfigOptionSchema(),
      )
      .optional()
      .describe(
        'User-configurable values this plugin needs. Prompted at enable time. ' +
          'Non-sensitive values saved to settings.json; sensitive values to secure storage ' +
          '(macOS keychain or .credentials.json). Available as ${user_config.KEY} in ' +
          'MCP/LSP server config, hook commands, and (non-sensitive only) skill/agent content. ' +
          'Note: sensitive values share a single keychain entry with OAuth tokens — keep ' +
          'secret counts small to stay under the ~2KB stdin-safe limit (see INC-3028).',
      ),
  }),
)

/**
 * 插件清单中频道声明的 Schema。
 *
 * 频道是发出 `notifications/zy/channel` 的 MCP 服务器，用于
 * 向对话中注入消息（Telegram、Slack、Discord 等）。
 * 在此声明让插件在安装时通过 PluginOptionsFlow 提示
 * 用户配置（bot 令牌、所有者 ID），而非要求用户手动编辑 settings.json。
 *
 * `server` 字段必须与插件的 `mcpServers` 中的键匹配 — 这在
 * Schema 解析时不交叉验证（mcpServers 字段可能是指向我们尚未
 * 读取的 JSON 文件的路径），因此检查发生在 mcpPluginIntegration.ts 加载时。
 */
const PluginManifestChannelsSchema = lazySchema(() =>
  z.object({
    channels: z
      .array(
        z
          .object({
            server: z
              .string()
              .min(1)
              .describe(
                "Name of the MCP server this channel binds to. Must match a key in this plugin's mcpServers.",
              ),
            displayName: z
              .string()
              .optional()
              .describe(
                'Human-readable name shown in the config dialog title (e.g., "Telegram"). Defaults to the server name.',
              ),
            userConfig: z
              .record(z.string(), PluginUserConfigOptionSchema())
              .optional()
              .describe(
                'Fields to prompt the user for when enabling this plugin in assistant mode. ' +
                  'Saved values are substituted into ${user_config.KEY} references in the mcpServers env.',
              ),
          })
          .strict(),
      )
      .describe(
        'Channels this plugin provides. Each entry declares an MCP server as a message channel ' +
          'and optionally specifies user configuration to prompt for at enable time.',
      ),
  }),
)

/**
 * 单个 LSP 服务器配置的 Schema。
 */
export const LspServerConfigSchema = lazySchema(() =>
  z.strictObject({
    command: z
      .string()
      .min(1)
      .refine(
        (cmd) => {
          // 带空格的命令应使用 args 数组
          if (cmd.includes(' ') && !cmd.startsWith('/')) {
            return false
          }
          return true
        },
        {
          message: 'Command should not contain spaces. Use args array for arguments.',
        },
      )
      .describe('Command to execute the LSP server (e.g., "typescript-language-server")'),
    args: z
      .array(nonEmptyString())
      .optional()
      .describe('Command-line arguments to pass to the server'),
    extensionToLanguage: z
      .record(fileExtension(), nonEmptyString())
      .refine((record) => Object.keys(record).length > 0, {
        message: 'extensionToLanguage must have at least one mapping',
      })
      .describe(
        'Mapping from file extension to LSP language ID. File extensions and languages are derived from this mapping.',
      ),
    transport: z
      .enum(['stdio', 'socket'])
      .default('stdio')
      .describe('Communication transport mechanism'),
    env: z
      .record(z.string(), z.string())
      .optional()
      .describe('Environment variables to set when starting the server'),
    initializationOptions: z
      .unknown()
      .optional()
      .describe('Initialization options passed to the server during initialization'),
    settings: z
      .unknown()
      .optional()
      .describe('Settings passed to the server via workspace/didChangeConfiguration'),
    workspaceFolder: z.string().optional().describe('Workspace folder path to use for the server'),
    startupTimeout: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Maximum time to wait for server startup (milliseconds)'),
    shutdownTimeout: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Maximum time to wait for graceful shutdown (milliseconds)'),
    restartOnCrash: z.boolean().optional().describe('Whether to restart the server if it crashes'),
    maxRestarts: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Maximum number of restart attempts before giving up'),
  }),
)

/**
 * 插件清单中 LSP 服务器声明的 Schema。
 * 支持多种格式：
 * - 字符串：指向 .lsp.json 文件的路径
 * - 对象：内联服务器配置 { "serverName": {...} }
 * - 数组：字符串和对象的混合
 */
const PluginManifestLspServerSchema = lazySchema(() =>
  z.object({
    lspServers: z.union([
      RelativeJSONPath().describe('Path to .lsp.json configuration file relative to plugin root'),
      z
        .record(z.string(), LspServerConfigSchema())
        .describe('LSP server configurations keyed by server name'),
      z
        .array(
          z.union([
            RelativeJSONPath().describe('Path to LSP configuration file'),
            z
              .record(z.string(), LspServerConfigSchema())
              .describe('Inline LSP server configurations'),
          ]),
        )
        .describe('Array of LSP server configurations (paths or inline definitions)'),
    ]),
  }),
)

/**
 * 插件后台监控（monitors）的 Schema。
 *
 * monitors 在 session 启动或 skill 调用时自动启动，
 * 持续监听事件和状态变化，类似守护进程（daemon）。
 * 适合日志监控、资源监控、自动修复等场景。
 *
 * 支持多种格式：
 * - 字符串：指向 monitor 脚本的相对路径
 * - 对象数组：完整的 monitor 配置
 * - 对象映射：{ "monitorName": { command, trigger, ... } }
 */
const MonitorConfigSchema = lazySchema(() =>
  z.object({
    name: z.string().min(1).describe('Monitor display name'),
    command: z.string().min(1).describe('Shell command to execute'),
    trigger: z
      .enum(['session_start', 'skill_invoke'])
      .optional()
      .default('session_start')
      .describe('When to start this monitor'),
    cwd: z.string().optional().describe('Working directory for the command'),
    env: z
      .record(z.string(), z.string())
      .optional()
      .describe('Environment variables for the monitor process'),
  }),
)

const PluginManifestMonitorsSchema = lazySchema(() =>
  z.object({
    monitors: z.union([
      RelativePath().describe('Path to monitors configuration file'),
      z.array(MonitorConfigSchema()).describe('Array of monitor configurations'),
      z
        .record(
          z.string(),
          z.object({
            command: z.string().min(1),
            trigger: z.enum(['session_start', 'skill_invoke']).optional(),
            cwd: z.string().optional(),
            env: z.record(z.string(), z.string()).optional(),
          }),
        )
        .describe('Named monitor configurations (name inferred from key)'),
    ]),
  }),
)

/**
 * npm 包名称的 Schema
 *
 * 验证 npm 包名称，包括带作用域的包。
 * 通过禁止 '..' 和 '//' 防止路径遍历攻击。
 *
 * 有效示例：
 * - "express"
 * - "@babel/core"
 * - "lodash.debounce"
 *
 * 无效示例：
 * - "../../../etc/passwd"
 * - "package//name"
 */
const NpmPackageNameSchema = lazySchema(() =>
  z
    .string()
    .refine(
      (name) => !name.includes('..') && !name.includes('//'),
      'Package name cannot contain path traversal patterns',
    )
    .refine((name) => {
      // 允许带作用域的包（@org/package）和普通包
      const scopedPackageRegex = /^@[a-z0-9][a-z0-9-._]*\/[a-z0-9][a-z0-9-._]*$/
      const regularPackageRegex = /^[a-z0-9][a-z0-9-._]*$/
      return scopedPackageRegex.test(name) || regularPackageRegex.test(name)
    }, 'Invalid npm package name format'),
)

/**
 * 将合并到设置级联中的插件设置的 Schema。
 * 在此接受任何记录；在 pluginLoader.ts 中通过
 * PluginSettingsSchema（派生自 SettingsSchema）过滤到允许列表。
 */
const PluginManifestSettingsSchema = lazySchema(() =>
  z.object({
    settings: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        'Settings to merge when plugin is enabled. ' +
          'Only allowlisted keys are kept (currently: agent)',
      ),
  }),
)

/**
 * 插件清单文件（plugin.json）
 *
 * 此 Schema 验证插件清单的结构，并在从磁盘加载插件时提供
 * 运行时类型检查。
 *
 * 未知顶层字段会被静默剥离（zod 默认值）而非拒绝。
 * 这使插件加载对插件作者可能添加的自定义/未来顶层字段
 * 具有弹性。嵌套配置对象（userConfig 选项、频道、lspServers）
 * 保持严格 — 这些内部的未知键仍会失败，因为那更可能是作者
 * 打字错误而非供应商扩展。类型不匹配和其他验证错误在所有层级
 * 仍会失败。对于未知顶层字段的开发者反馈，使用 `zy plugin validate`。
 */
export const PluginManifestSchema = lazySchema(() =>
  z.object({
    ...PluginManifestMetadataSchema().shape,
    ...PluginManifestHooksSchema().partial().shape,
    ...PluginManifestCommandsSchema().partial().shape,
    ...PluginManifestAgentsSchema().partial().shape,
    ...PluginManifestSkillsSchema().partial().shape,
    ...PluginManifestOutputStylesSchema().partial().shape,
    ...PluginManifestChannelsSchema().partial().shape,
    ...PluginManifestMcpServerSchema().partial().shape,
    ...PluginManifestLspServerSchema().partial().shape,
    ...PluginManifestMonitorsSchema().partial().shape,
    ...PluginManifestSettingsSchema().partial().shape,
    ...PluginManifestUserConfigSchema().partial().shape,
  }),
)

/**
 * 市场源位置的 Schema
 *
 * 定义了引用市场清单的各种方式，包括直接 URL、GitHub 仓库、
 * git URL、npm 包和本地路径。
 */
export const MarketplaceSourceSchema = lazySchema(() =>
  z.discriminatedUnion('source', [
    z.object({
      source: z.literal('url'),
      url: z.string().url().describe('Direct URL to marketplace.json file'),
      headers: z
        .record(z.string(), z.string())
        .optional()
        .describe('Custom HTTP headers (e.g., for authentication)'),
    }),
    z.object({
      source: z.literal('github'),
      repo: z.string().describe('GitHub repository in owner/repo format'),
      ref: z
        .string()
        .optional()
        .describe(
          'Git branch or tag to use (e.g., "main", "v1.0.0"). Defaults to repository default branch.',
        ),
      path: z
        .string()
        .optional()
        .describe('Path to marketplace.json within repo (defaults to .zy-plugin/marketplace.json)'),
      sparsePaths: z
        .array(z.string())
        .optional()
        .describe(
          'Directories to include via git sparse-checkout (cone mode). ' +
            'Use for monorepos where the marketplace lives in a subdirectory. ' +
            'Example: [".zy-plugin", "plugins"]. ' +
            'If omitted, the full repository is cloned.',
        ),
    }),
    z.object({
      source: z.literal('git'),
      // 没有 .endsWith('.git') — 这是 GitHub/GitLab/Bitbucket 的约定，
      // 而非 git 要求。Azure DevOps 使用
      // https://dev.azure.com/{org}/{proj}/_git/{repo} 无后缀，追加
      // .git 会让 ADO 寻找字面名为 {repo}.git 的仓库（TF401019）。
      // AWS CodeCommit 也省略后缀。如果用户明确写了 source:'git'，
      // 他们知道这是 git 仓库；URL 打字错误会在 `git clone` 时给出
      // 更清晰的错误。（gh-31256）
      url: z.string().describe('Full git repository URL'),
      ref: z
        .string()
        .optional()
        .describe(
          'Git branch or tag to use (e.g., "main", "v1.0.0"). Defaults to repository default branch.',
        ),
      path: z
        .string()
        .optional()
        .describe('Path to marketplace.json within repo (defaults to .zy-plugin/marketplace.json)'),
      sparsePaths: z
        .array(z.string())
        .optional()
        .describe(
          'Directories to include via git sparse-checkout (cone mode). ' +
            'Use for monorepos where the marketplace lives in a subdirectory. ' +
            'Example: [".zy-plugin", "plugins"]. ' +
            'If omitted, the full repository is cloned.',
        ),
    }),
    z.object({
      source: z.literal('npm'),
      package: NpmPackageNameSchema().describe('NPM package containing marketplace.json'),
    }),
    z.object({
      source: z.literal('file'),
      path: z.string().describe('Local file path to marketplace.json'),
    }),
    z.object({
      source: z.literal('directory'),
      path: z.string().describe('Local directory containing .zy-plugin/marketplace.json'),
    }),
    z.object({
      source: z.literal('hostPattern'),
      hostPattern: z
        .string()
        .describe(
          'Regex pattern to match the host/domain extracted from any marketplace source type. ' +
            'For github sources, matches against "github.com". For git sources (SSH or HTTPS), ' +
            'extracts the hostname from the URL. Use in strictKnownMarketplaces to allow all ' +
            'marketplaces from a specific host (e.g., "^github\\.mycompany\\.com$").',
        ),
    }),
    z.object({
      source: z.literal('pathPattern'),
      pathPattern: z
        .string()
        .describe(
          'Regex pattern matched against the .path field of file and directory sources. ' +
            'Use in strictKnownMarketplaces to allow filesystem-based marketplaces alongside ' +
            'hostPattern restrictions for network sources. Use ".*" to allow all filesystem ' +
            'paths, or a narrower pattern (e.g., "^/opt/approved/") to restrict to specific ' +
            'directories.',
        ),
    }),
    z
      .object({
        source: z.literal('settings'),
        name: MarketplaceNameSchema()
          .refine((name) => !ALLOWED_OFFICIAL_MARKETPLACE_NAMES.has(name.toLowerCase()), {
            message:
              'Reserved official marketplace names cannot be used with settings sources. ' +
              'validateOfficialNameSource only accepts github/git sources from anthropics/* ' +
              'for these names; a settings source would be rejected after ' +
              'loadAndCacheMarketplace has already written to disk with cleanupNeeded=false.',
          })
          .describe(
            'Marketplace name. Must match the extraKnownMarketplaces key (enforced); ' +
              'the synthetic manifest is written under this name. Same validation ' +
              'as PluginMarketplaceSchema plus reserved-name rejection \u2014 ' +
              'validateOfficialNameSource runs after the disk write, too late to clean up.',
          ),
        plugins: z
          .array(SettingsMarketplacePluginSchema())
          .describe('Plugin entries declared inline in settings.json'),
        owner: PluginAuthorSchema().optional(),
      })
      .describe(
        'Inline marketplace manifest defined directly in settings.json. ' +
          'The reconciler writes a synthetic marketplace.json to the cache; ' +
          'diffMarketplaces detects edits via isEqual on the stored source ' +
          '(the plugins array is inside this object, so edits surface as sourceChanged).',
      ),
  ]),
)

export const gitSha = lazySchema(() =>
  z
    .string()
    .length(40)
    .regex(/^[a-f0-9]{40}$/, 'Must be a full 40-character lowercase git commit SHA'),
)

/**
 * Schema for plugin source locations
 *
 * Defines various ways to reference and install plugins including
 * local paths, npm packages, Python packages, git URLs, and GitHub repos.
 */
export const PluginSourceSchema = lazySchema(() =>
  z.union([
    RelativePath().describe(
      'Path to the plugin root, relative to the marketplace root (the directory containing .zy-plugin/, not .zy-plugin/ itself)',
    ),
    z
      .object({
        source: z.literal('npm'),
        package: NpmPackageNameSchema()
          .or(z.string()) // Allow URLs and local paths as well
          .describe(
            'Package name (or url, or local path, or anything else that can be passed to `npm` as a package)',
          ),
        version: z
          .string()
          .optional()
          .describe('Specific version or version range (e.g., ^1.0.0, ~2.1.0)'),
        registry: z
          .string()
          .url()
          .optional()
          .describe('Custom NPM registry URL (defaults to using system default, likely npmjs.org)'),
      })
      .describe('NPM package as plugin source'),
    z
      .object({
        source: z.literal('pip'),
        package: z.string().describe('Python package name as it appears on PyPI'),
        version: z
          .string()
          .optional()
          .describe('Version specifier (e.g., ==1.0.0, >=2.0.0, <3.0.0)'),
        registry: z
          .string()
          .url()
          .optional()
          .describe('Custom PyPI registry URL (defaults to using system default, likely pypi.org)'),
      })
      .describe('Python package as plugin source'),
    z.object({
      source: z.literal('url'),
      // See note on MarketplaceSourceSchema source:'git' re: .endsWith('.git')
      // — dropped to support Azure DevOps / CodeCommit URLs (gh-31256).
      url: z.string().describe('Full git repository URL (https:// or git@)'),
      ref: z
        .string()
        .optional()
        .describe(
          'Git branch or tag to use (e.g., "main", "v1.0.0"). Defaults to repository default branch.',
        ),
      sha: gitSha().optional().describe('Specific commit SHA to use'),
    }),
    z.object({
      source: z.literal('github'),
      repo: z.string().describe('GitHub repository in owner/repo format'),
      ref: z
        .string()
        .optional()
        .describe(
          'Git branch or tag to use (e.g., "main", "v1.0.0"). Defaults to repository default branch.',
        ),
      sha: gitSha().optional().describe('Specific commit SHA to use'),
    }),
    z
      .object({
        source: z.literal('git-subdir'),
        url: z
          .string()
          .describe('Git repository: GitHub owner/repo shorthand, https://, or git@ URL'),
        path: z
          .string()
          .min(1)
          .describe(
            'Subdirectory within the repo containing the plugin (e.g., "tools/zy-plugin"). ' +
              'Cloned sparsely using partial clone (--filter=tree:0) to minimize bandwidth for monorepos.',
          ),
        ref: z
          .string()
          .optional()
          .describe(
            'Git branch or tag to use (e.g., "main", "v1.0.0"). Defaults to repository default branch.',
          ),
        sha: gitSha().optional().describe('Specific commit SHA to use'),
      })
      .describe(
        'Plugin located in a subdirectory of a larger repository (monorepo). ' +
          'Only the specified subdirectory is materialized; the rest of the repo is not downloaded.',
      ),
    // TODO (future work) gist
    // TODO (future work) single file?
  ]),
)

/**
 * Narrow plugin entry for settings-sourced marketplaces.
 *
 * Settings-sourced marketplaces point at remote plugins that have their own
 * plugin.json — there is no reason to inline commands/agents/hooks/mcp/lsp in
 * settings.json. This schema carries only what loadPluginFromMarketplaceEntry
 * reads (name, source, version, strict) plus description for discoverability.
 *
 * The synthetic marketplace.json written by loadAndCacheMarketplace is re-parsed
 * with the full PluginMarketplaceSchema, which widens these entries back to
 * PluginMarketplaceEntry (strict gets its .default(true), everything else stays
 * undefined). So this narrowness is settings-surface-only; downstream code sees
 * the same shape it would from any sparse marketplace.json entry.
 *
 * Keeping this narrow prevents PluginManifestSchema().partial() from expanding
 * inline in settingsTypes.generated.ts — that expansion is ~870 lines per
 * occurrence, and MarketplaceSource appears three times in the settings schema
 * (extraKnownMarketplaces, strictKnownMarketplaces, blockedMarketplaces).
 */
const SettingsMarketplacePluginSchema = lazySchema(() =>
  z
    .object({
      name: z
        .string()
        .min(1, 'Plugin name cannot be empty')
        .refine((name) => !name.includes(' '), {
          message: 'Plugin name cannot contain spaces. Use kebab-case (e.g., "my-plugin")',
        })
        .describe('Plugin name as it appears in the target repository'),
      source: PluginSourceSchema().describe(
        'Where to fetch the plugin from. Must be a remote source — relative ' +
          'paths have no marketplace repository to resolve against.',
      ),
      description: z.string().optional(),
      version: z.string().optional(),
      strict: z.boolean().optional(),
    })
    .refine((p) => typeof p.source !== 'string', {
      message:
        'Plugins in a settings-sourced marketplace must use remote sources ' +
        '(github, git-subdir, npm, url, pip). Relative-path sources like "./foo" ' +
        'have no marketplace repository to resolve against.',
    }),
)

/**
 * Check if a plugin source is a local path (stored in marketplace directory).
 *
 * Local plugins have their source as a string starting with './' (relative to marketplace).
 * External plugins have their source as an object (npm, pip, git, github, etc.).
 *
 * This function provides a semantic wrapper around the './' prefix check, making
 * the intent clear and centralizing the logic for determining plugin source type.
 *
 * @param source The plugin source from PluginMarketplaceEntry
 * @returns true if the source is a local path, false if it's an external source
 */
export function isLocalPluginSource(source: PluginSource): source is string {
  return typeof source === 'string' && source.startsWith('./')
}

/**
 * Whether a marketplace source points at a user-controlled local filesystem path.
 *
 * For local sources (`file`/`directory`), `installLocation` IS the user's path —
 * it lives outside the plugins cache dir and marketplace operations on it are
 * read-only. For remote sources (`github`/`git`/`url`/`npm`), `installLocation`
 * is a cache-dir entry managed by ZY Code and subject to rm/re-clone.
 *
 * Contrast with isLocalPluginSource, which operates on PluginSource (the
 * per-plugin source inside a marketplace entry) and checks for `./` prefix.
 */
export function isLocalMarketplaceSource(
  source: MarketplaceSource,
): source is Extract<MarketplaceSource, { source: 'file' | 'directory' }> {
  return source.source === 'file' || source.source === 'directory'
}

/**
 * Schema for individual plugin entries in a marketplace
 *
 * When strict=true (default): Plugin.json is required, marketplace fields supplement it
 * When strict=false: Plugin.json is optional, marketplace provides full manifest
 *
 * Unknown fields are silently stripped (zod default) rather than rejected.
 * Marketplace entries are validated as an array — if one entry rejected
 * unknown keys, the whole marketplace.json would fail to parse and ALL
 * plugins from that marketplace would become unavailable. Stripping keeps
 * the blast radius to zero for custom/future fields.
 */
export const PluginMarketplaceEntrySchema = lazySchema(() =>
  PluginManifestSchema()
    .partial()
    .extend({
      name: z
        .string()
        .min(1, 'Plugin name cannot be empty')
        .refine((name) => !name.includes(' '), {
          message: 'Plugin name cannot contain spaces. Use kebab-case (e.g., "my-plugin")',
        })
        .describe('Unique identifier matching the plugin name'),
      source: PluginSourceSchema().describe('Where to fetch the plugin from'),
      category: z
        .string()
        .optional()
        .describe('Category for organizing plugins (e.g., "productivity", "development")'),
      tags: z.array(z.string()).optional().describe('Tags for searchability and discovery'),
      strict: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          'Require the plugin manifest to be present in the plugin folder. If false, the marketplace entry provides the manifest.',
        ),
    }),
)

/**
 * Schema for plugin marketplace configuration
 *
 * Defines the structure for curated collections of plugins that can
 * be discovered and installed from a central repository.
 */
export const PluginMarketplaceSchema = lazySchema(() =>
  z.object({
    name: MarketplaceNameSchema(),
    owner: PluginAuthorSchema().describe('Marketplace maintainer or curator information'),
    plugins: z
      .array(PluginMarketplaceEntrySchema())
      .describe('Collection of available plugins in this marketplace'),
    forceRemoveDeletedPlugins: z
      .boolean()
      .optional()
      .describe(
        'When true, plugins removed from this marketplace will be automatically uninstalled and flagged for users',
      ),
    metadata: z
      .object({
        pluginRoot: z.string().optional().describe('Base path for relative plugin sources'),
        version: z.string().optional().describe('Marketplace version'),
        description: z.string().optional().describe('Marketplace description'),
      })
      .optional()
      .describe('Optional marketplace metadata'),
    allowCrossMarketplaceDependenciesOn: z
      .array(z.string())
      .optional()
      .describe(
        "Marketplace names whose plugins may be auto-installed as dependencies. Only the root marketplace's allowlist applies \u2014 no transitive trust.",
      ),
  }),
)

/**
 * Schema for plugin ID format
 *
 * Plugin IDs follow the format: "plugin-name@marketplace-name"
 * Both parts allow alphanumeric characters, hyphens, dots, and underscores.
 *
 * Examples:
 * - "code-formatter@anthropic-tools"
 * - "db_assistant@company-internal"
 * - "my.plugin@personal-marketplace"
 */
export const PluginIdSchema = lazySchema(() =>
  z
    .string()
    .regex(
      /^[a-z0-9][-a-z0-9._]*@[a-z0-9][-a-z0-9._]*$/i,
      'Plugin ID must be in format: plugin@marketplace',
    ),
)

const DEP_REF_REGEX = /^[a-z0-9][-a-z0-9._]*(@[a-z0-9][-a-z0-9._]*)?(@\^[^@]*)?$/i

/**
 * Schema for entries in a plugin's `dependencies` array.
 *
 * Accepts three forms, all normalized to a plain "name" or "name@mkt" string
 * by the transform — downstream code (qualifyDependency, resolveDependencyClosure,
 * verifyAndDemote) never sees versions or objects:
 *
 *   "plugin"                → bare, resolved against declaring plugin's marketplace
 *   "plugin@marketplace"    → qualified
 *   "plugin@mkt@^1.2"       → trailing @^version silently stripped (forwards-compat)
 *   {name, marketplace?, …} → object form, version etc. stripped (forwards-compat)
 *
 * The latter two are permitted-but-ignored so future clients adding version
 * constraints don't cause old clients to fail schema validation and reject
 * the whole plugin. See CC-993 for the eventual version-range design.
 */
export const DependencyRefSchema = lazySchema(() =>
  z.union([
    z
      .string()
      .regex(
        DEP_REF_REGEX,
        'Dependency must be a plugin name, optionally qualified with @marketplace',
      )
      .transform((s) => s.replace(/@\^[^@]*$/, '')),
    z
      .object({
        name: z
          .string()
          .min(1)
          .regex(/^[a-z0-9][-a-z0-9._]*$/i),
        marketplace: z
          .string()
          .min(1)
          .regex(/^[a-z0-9][-a-z0-9._]*$/i)
          .optional(),
      })
      .loose()
      .transform((o) => (o.marketplace ? `${o.name}@${o.marketplace}` : o.name)),
  ]),
)

/**
 * Schema for plugin reference in settings (repo or user level)
 *
 * Can be either:
 * - Simple string: "plugin-name@marketplace-name"
 * - Object with additional configuration
 *
 * The plugin source (npm, git, local) is defined in the marketplace entry itself,
 * not in the plugin reference.
 *
 * Examples:
 * - "code-formatter@anthropic-tools"
 * - "db-assistant@company-internal"
 * - { id: "formatter@tools", version: "^2.0.0", required: true }
 */
export const SettingsPluginEntrySchema = lazySchema(() =>
  z.union([
    // Simple format: "plugin@marketplace"
    PluginIdSchema(),
    // Extended format with configuration
    z.object({
      id: PluginIdSchema().describe('Plugin identifier (e.g., "formatter@tools")'),
      version: z.string().optional().describe('Version constraint (e.g., "^2.0.0")'),
      required: z.boolean().optional().describe('If true, cannot be disabled'),
      config: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Plugin-specific configuration'),
    }),
  ]),
)

/**
 * Schema for installed plugin metadata (V1 format)
 *
 * Tracks the actual installation state of a plugin. All plugins are
 * installed from marketplaces, which contain the actual source details
 * (npm, git, local, etc.). The plugin ID is the key in the plugins record,
 * so it's not duplicated here.
 *
 * Example entry for key "code-formatter@anthropic-tools":
 * {
 *   "version": "1.2.0",
 *   "installedAt": "2024-01-15T10:30:00Z",
 *   "marketplace": "anthropic-tools",
 *   "installPath": "/home/user/.zy/plugins/installed/anthropic-tools/code-formatter"
 * }
 */
export const InstalledPluginSchema = lazySchema(() =>
  z.object({
    version: z.string().describe('Currently installed version'),
    installedAt: z.string().describe('ISO 8601 timestamp of installation'),
    lastUpdated: z.string().optional().describe('ISO 8601 timestamp of last update'),
    installPath: z.string().describe('Absolute path to the installed plugin directory'),
    gitCommitSha: z
      .string()
      .optional()
      .describe('Git commit SHA for git-based plugins (for version tracking)'),
  }),
)

/**
 * Schema for the installed_plugins.json file (V1 format)
 *
 * Contains a version number and maps plugin IDs to their installation metadata.
 * Maintained automatically by ZY Code, not edited by users.
 *
 * The version field tracks schema changes. When the version doesn't match
 * the current schema version, ZY Code will update the file on next startup.
 *
 * Example file:
 * {
 *   "version": 1,
 *   "plugins": {
 *     "code-formatter@anthropic-tools": { ... },
 *     "db-assistant@company-internal": { ... }
 *   }
 * }
 */
export const InstalledPluginsFileSchemaV1 = lazySchema(() =>
  z.object({
    version: z.literal(1).describe('Schema version 1'),
    plugins: z
      .record(
        PluginIdSchema(), // Validated plugin ID key (e.g., "formatter@tools")
        InstalledPluginSchema(),
      )
      .describe('Map of plugin IDs to their installation metadata'),
  }),
)

/**
 * Scope types for plugin installation (V2)
 *
 * Plugins can be installed at different scopes:
 * - managed: Enterprise/system-wide (read-only, platform-specific paths)
 * - user: User's global settings (~/.zy/settings.json)
 * - project: Shared project settings ($project/.zy/settings.json)
 * - local: Personal project overrides ($project/.zy/settings.local.json)
 *
 * Note: 'flag' scope plugins (from --settings) are session-only and
 * are NOT persisted to installed_plugins.json.
 */
export const PluginScopeSchema = lazySchema(() => z.enum(['managed', 'user', 'project', 'local']))

/**
 * Schema for a single plugin installation entry (V2)
 *
 * Each plugin can have multiple installations at different scopes.
 * For example, the same plugin could be installed at user scope with v1.0
 * and at project scope with v1.1.
 */
export const PluginInstallationEntrySchema = lazySchema(() =>
  z.object({
    scope: PluginScopeSchema().describe('Installation scope'),
    projectPath: z.string().optional().describe('Project path (required for project/local scopes)'),
    installPath: z.string().describe('Absolute path to the versioned plugin directory'),
    // Preserved from V1:
    version: z.string().optional().describe('Currently installed version'),
    installedAt: z.string().optional().describe('ISO 8601 timestamp of installation'),
    lastUpdated: z.string().optional().describe('ISO 8601 timestamp of last update'),
    gitCommitSha: z.string().optional().describe('Git commit SHA for git-based plugins'),
  }),
)

/**
 * Schema for the installed_plugins.json file (V2 format)
 *
 * V2 changes from V1:
 * - Each plugin ID maps to an ARRAY of installations (one per scope)
 * - Supports multi-scope installation (same plugin at different scopes/versions)
 *
 * Example file:
 * {
 *   "version": 2,
 *   "plugins": {
 *     "code-formatter@anthropic-tools": [
 *       { "scope": "user", "installPath": "...", "version": "1.0.0" },
 *       { "scope": "project", "projectPath": "/path/to/project", "installPath": "...", "version": "1.1.0" }
 *     ]
 *   }
 * }
 */
export const InstalledPluginsFileSchemaV2 = lazySchema(() =>
  z.object({
    version: z.literal(2).describe('Schema version 2'),
    plugins: z
      .record(PluginIdSchema(), z.array(PluginInstallationEntrySchema()))
      .describe('Map of plugin IDs to arrays of installation entries'),
  }),
)

/**
 * Combined schema that accepts both V1 and V2 formats
 * Used for reading existing files before migration
 */
export const InstalledPluginsFileSchema = lazySchema(() =>
  z.union([InstalledPluginsFileSchemaV1(), InstalledPluginsFileSchemaV2()]),
)

/**
 * Schema for a known marketplace entry
 *
 * Tracks metadata about a registered marketplace in the user's configuration.
 * Each entry contains the source location, cache path, and last update time.
 *
 * Example entry:
 * {
 *   "source": { "source": "github", "repo": "anthropic/zy-plugins" },
 *   "installLocation": "/home/user/.zy/plugins/cached/marketplaces/anthropic-tools",
 *   "lastUpdated": "2024-01-15T10:30:00Z"
 * }
 */
export const KnownMarketplaceSchema = lazySchema(() =>
  z.object({
    source: MarketplaceSourceSchema().describe('Where to fetch the marketplace from'),
    installLocation: z.string().describe('Local cache path where marketplace manifest is stored'),
    lastUpdated: z.string().describe('ISO 8601 timestamp of last marketplace refresh'),
    autoUpdate: z
      .boolean()
      .optional()
      .describe(
        'Whether to automatically update this marketplace and its installed plugins on startup',
      ),
  }),
)

/**
 * Schema for the known_marketplaces.json file
 *
 * Maps marketplace names to their source and cache metadata.
 * Used to track which marketplaces are registered and where to find them.
 *
 * Example file:
 * {
 *   "anthropic-tools": { "source": { ... }, "installLocation": "...", "lastUpdated": "..." },
 *   "company-internal": { "source": { ... }, "installLocation": "...", "lastUpdated": "..." }
 * }
 */
export const KnownMarketplacesFileSchema = lazySchema(() =>
  z.record(
    z.string(), // Marketplace name as key
    KnownMarketplaceSchema(),
  ),
)

// Inferred types from schemas
/**
 * Metadata for plugin command definitions.
 *
 * Commands can be defined with either:
 * - `source`: Path to a markdown file (e.g., "./README.md")
 * - `content`: Inline markdown content string
 *
 * INVARIANT: Exactly one of `source` or `content` must be present.
 * This invariant is enforced at runtime by CommandMetadataSchema validation.
 *
 * Validation occurs at plugin manifest parsing. Metadata is assumed valid
 * after passing through createPluginFromPath().
 *
 * @see CommandMetadataSchema for runtime validation rules
 */
export type CommandMetadata = z.infer<ReturnType<typeof CommandMetadataSchema>>
export type MarketplaceSource = z.infer<ReturnType<typeof MarketplaceSourceSchema>>
export type PluginAuthor = z.infer<ReturnType<typeof PluginAuthorSchema>>
export type PluginSource = z.infer<ReturnType<typeof PluginSourceSchema>>
export type PluginManifest = z.infer<ReturnType<typeof PluginManifestSchema>>
export type PluginManifestChannel = NonNullable<PluginManifest['channels']>[number]

export type PluginMarketplace = z.infer<ReturnType<typeof PluginMarketplaceSchema>>
export type PluginMarketplaceEntry = z.infer<ReturnType<typeof PluginMarketplaceEntrySchema>>
export type PluginId = z.infer<ReturnType<typeof PluginIdSchema>> // string in "plugin@marketplace" format
export type InstalledPlugin = z.infer<ReturnType<typeof InstalledPluginSchema>>
export type InstalledPluginsFileV1 = z.infer<ReturnType<typeof InstalledPluginsFileSchemaV1>>
export type InstalledPluginsFileV2 = z.infer<ReturnType<typeof InstalledPluginsFileSchemaV2>>
export type PluginScope = z.infer<ReturnType<typeof PluginScopeSchema>>
export type PluginInstallationEntry = z.infer<ReturnType<typeof PluginInstallationEntrySchema>>
export type KnownMarketplace = z.infer<ReturnType<typeof KnownMarketplaceSchema>>
export type KnownMarketplacesFile = z.infer<ReturnType<typeof KnownMarketplacesFileSchema>> // Record<string, KnownMarketplace>
