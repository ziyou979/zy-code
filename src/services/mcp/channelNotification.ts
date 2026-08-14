/**
 * Channel notification 允许 MCP server 将用户消息推入对话。Discord、Slack、SMS 等
 * channel 本质上是满足以下条件的 MCP server：
 *   - 暴露发送消息的 tool，例如标准 MCP `send_message`；
 *   - 通过本文件的 `notifications/zy/channel` 发送入站通知。
 *
 * notification handler 用 <channel> tag 包装内容并入队。SleepTool 轮询
 * hasCommandsInQueue()，在 1 秒内唤醒。模型可看到消息来源，并决定使用 channel 的 MCP
 * tool、SendUserMessage 或同时使用二者回复。
 *
 * 构建开关为 feature('KAIROS') || feature('KAIROS_CHANNELS')，runtime gate 为 zy_harbor。
 * 要求 zy.ai OAuth 认证；在 console 提供 channelsEnabled 管理入口前，API key 用户会被阻止。
 * Teams/Enterprise 组织必须在 managed settings 中通过 channelsEnabled: true 显式启用。
 */

import type { ServerCapabilities } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod/v4'
import { type ChannelEntry, getAllowedChannels } from '../../bootstrap/runtime/runtimeContext.js'
import { CHANNEL_TAG } from '../../constants/xml.js'
import { getZyAIOAuthTokens } from '../auth/auth.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { parsePluginIdentifier } from '../plugins/pluginIdentifier.js'
import { getSettingsForSource } from '../settings/settings.js'
import { escapeXmlAttr } from '../../utils/xml.js'
import {
  type ChannelAllowlistEntry,
  getChannelAllowlist,
  isChannelsEnabled,
} from './channelAllowlist.js'

export const ChannelMessageNotificationSchema = lazySchema(() =>
  z.object({
    method: z.literal('notifications/zy/channel'),
    params: z.object({
      content: z.string(),
      // 不透明透传 thread_id、user 等 channel 希望模型看到的内容，并渲染为 <channel> tag 属性
      meta: z.record(z.string(), z.string()).optional(),
    }),
  }),
)

/**
 * channel server 发出的结构化权限回复。支持此能力的 server 声明
 * `capabilities.experimental['zy/channel/permission']`，并发出此事件，而不是通过
 * notifications/zy/channel 将 "yes tbxkq" 作为文本转发。每个 server 都需显式 opt-in，
 * 仅希望转发文本的 channel 不会意外成为权限入口。
 *
 * server 按规范 /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i 解析用户回复，并发出
 * {request_id, behavior}。CC 在 pending map 中匹配 request_id。与正则拦截方案不同，
 * 普通 channel 文本不会意外匹配；批准必须由 server 主动发出此特定事件。
 */
export const CHANNEL_PERMISSION_METHOD = 'notifications/zy/channel/permission'
export const ChannelPermissionNotificationSchema = lazySchema(() =>
  z.object({
    method: z.literal(CHANNEL_PERMISSION_METHOD),
    params: z.object({
      request_id: z.string(),
      behavior: z.enum(['allow', 'deny']),
    }),
  }),
)

/**
 * 出站方向为 CC → server。权限对话框打开且 server 已声明 permission capability 时，由
 * interactiveHandler.ts 发出。server 按平台格式化消息（Telegram markdown、iMessage 富文本、
 * Discord embed）并发送给用户。用户回复 "yes tbxkq" 后，server 使用
 * PERMISSION_REPLY_RE 解析并发出上方入站 schema。
 *
 * 此处不是 Zod schema，因为 CC 只发送而不校验；定义类型可将协议两端并列记录。
 */
export const CHANNEL_PERMISSION_REQUEST_METHOD = 'notifications/zy/channel/permission_request'
export type ChannelPermissionRequestParams = {
  request_id: string
  tool_name: string
  description: string
  /** JSON 字符串化的 tool 输入，以 … 截断至 200 字符。完整输入位于本地终端对话框，此处是
   *  适合手机显示的预览，由 server 决定是否及如何展示。 */
  input_preview: string
}

/**
 * meta key 会成为 XML 属性名，`x="" injected="y` 等构造 key 可突破属性结构，因此只接受
 * 普通标识符形式的 key。此规则比允许 `:`、`.`、`-` 的 XML 规范更严格，但实际 channel
 * server 只发送 `chat_id`、`user`、`thread_ts`、`message_id`。
 */
const SAFE_META_KEY = /^[a-zA-Z_][a-zA-Z0-9_]*$/

export function wrapChannelMessage(
  serverName: string,
  content: string,
  meta?: Record<string, string>,
): string {
  const attrs = Object.entries(meta ?? {})
    .filter(([k]) => SAFE_META_KEY.test(k))
    .map(([k, v]) => ` ${k}="${escapeXmlAttr(v)}"`)
    .join('')
  return `<${CHANNEL_TAG} source="${escapeXmlAttr(serverName)}"${attrs}>\n${content}\n</${CHANNEL_TAG}>`
}

/**
 * 当前会话的有效 allowlist。Team/enterprise 组织可在 managed settings 中设置
 * allowedChannelPlugins；设置后会替换 GrowthBook ledger，由管理员决定信任。undefined 时
 * 回退到 ledger，非托管用户始终使用 ledger。
 *
 * 调用方已为 policy gate 读取 sub/policy，因此直接传入，避免重复调用未缓存的
 * getSettingsForSource。
 */
export function getEffectiveChannelAllowlist(
  _sub: null,
  orgList: ChannelAllowlistEntry[] | undefined,
): {
  entries: ChannelAllowlistEntry[]
  source: 'org' | 'ledger'
} {
  // 没有 subscription context，不应用组织列表
  if (orgList) {
    return { entries: orgList, source: 'org' }
  }
  return { entries: getChannelAllowlist(), source: 'ledger' }
}

export type ChannelGateResult =
  | { action: 'register' }
  | {
      action: 'skip'
      kind: 'capability' | 'disabled' | 'auth' | 'policy' | 'session' | 'marketplace' | 'allowlist'
      reason: string
    }

/**
 * 将已连接 MCP server 与用户解析后的 --channels 条目匹配。server-kind 精确匹配裸名称；
 * plugin-kind 匹配 plugin:X:Y 的第二段。返回匹配条目供调用方读取 kind；这是用户的信任
 * 声明，不能从 runtime 结构推断。
 */
export function findChannelEntry(
  serverName: string,
  channels: readonly ChannelEntry[],
): ChannelEntry | undefined {
  // 始终 split；对于 slack 等裸名称，parts 为 ['slack']，plugin-kind 分支会因
  // parts[0] !== 'plugin' 而正确地不匹配
  const parts = serverName.split(':')
  return channels.find((c) =>
    c.kind === 'server' ? serverName === c.name : parts[0] === 'plugin' && parts[1] === c.name,
  )
}

/**
 * 控制 MCP server 的 channel-notification 路径。调用方先检查 feature('KAIROS') ||
 * feature('KAIROS_CHANNELS') 以便构建期消除。gate 顺序为 capability → runtime gate
 * (zy_harbor) → auth（仅 OAuth）→ org policy → session --channels → allowlist。
 * API key 用户在 auth 层被阻止，因为 channels 需要 zy.ai auth，console 组织尚无管理员
 * opt-in 入口。
 *
 *   skip      不是 channel server、托管组织未启用或不在会话 --channels 中；连接保持，
 *             不注册 handler。
 *   register  订阅 notifications/zy/channel。
 *
 * server 能否连接由 allowedMcpServers 决定；此 gate 只决定是否注册 notification handler。
 */
export function gateChannelServer(
  serverName: string,
  capabilities: ServerCapabilities | undefined,
  pluginSource: string | undefined,
): ChannelGateResult {
  // Channel server 声明 `experimental['zy/channel']: {}`，采用与 `tools: {}` 相同的 MCP
  // presence-signal 约定。`{}` 和 true 通过；缺失、undefined 或显式 false 均失败。key 与
  // notification method namespace（notifications/zy/channel）一致。
  if (!capabilities?.experimental?.['zy/channel']) {
    return {
      action: 'skip',
      kind: 'capability',
      reason: 'server did not declare zy/channel capability',
    }
  }

  // 总 runtime gate。放在 capability 之后，避免普通 MCP server 进入；放在 auth/policy
  // 之前，使 killswitch 不受会话状态影响。
  if (!isChannelsEnabled()) {
    return {
      action: 'skip',
      kind: 'disabled',
      reason: 'channels feature is not currently available',
    }
  }

  // 仅限 OAuth。API key 用户（console）会被阻止，因为 console 尚无 channelsEnabled 管理
  // 入口，无法完成 policy opt-in；console 能力对齐后移除此限制。
  if (!getZyAIOAuthTokens()?.accessToken) {
    return {
      action: 'skip',
      kind: 'auth',
      reason: 'channels requires zy.ai authentication (run /login)',
    }
  }

  // 没有 subscription context，不适用 team/enterprise policy gate
  const policy = getSettingsForSource('policySettings')
  if (false && policy?.channelsEnabled !== true) {
    return {
      action: 'skip',
      kind: 'policy',
      reason: 'channels not enabled by org policy (set channelsEnabled: true in managed settings)',
    }
  }

  // 用户级会话 opt-in。server 必须显式列入 --channels 才能在本会话推送入站消息，防止已信任
  // server 突然新增 capability。
  const entry = findChannelEntry(serverName, getAllowedChannels())
  if (!entry) {
    return {
      action: 'skip',
      kind: 'session',
      reason: `server ${serverName} not in --channels list for this session`,
    }
  }

  if (entry.kind === 'plugin') {
    // Marketplace 校验：tag 表示意图（plugin:slack@anthropic），runtime 名称只有
    // plugin:slack:X，实际可能是 slack@anthropic 或 slack@evil。用于下方 allowlist 前先验证
    // 二者一致。source 由 addPluginScopeToServers 存入配置；undefined（非 plugin server，
    // plugin-kind 条目中不应出现）或不含 @（builtin/inline）均无法通过比较。
    const actual = pluginSource ? parsePluginIdentifier(pluginSource).marketplace : undefined
    if (actual !== entry.marketplace) {
      return {
        action: 'skip',
        kind: 'marketplace',
        reason: `you asked for plugin:${entry.name}@${entry.marketplace} but the installed ${entry.name} plugin is from ${actual ?? 'an unknown source'}`,
      }
    }

    // 已批准 plugin allowlist。Marketplace gate 已验证 tag 与实际来源一致，此处只检查条目。
    // entry.dev 是逐条目而非会话级标记，可绕过检查，因此接受一个条目的 dev 对话框不会让
    // 其他 --channels 条目也绕过 allowlist。
    if (!entry.dev) {
      const { entries, source } = getEffectiveChannelAllowlist(null, policy?.allowedChannelPlugins)
      if (!entries.some((e) => e.plugin === entry.name && e.marketplace === entry.marketplace)) {
        return {
          action: 'skip',
          kind: 'allowlist',
          reason:
            source === 'org'
              ? `plugin ${entry.name}@${entry.marketplace} is not on your org's approved channels list (set allowedChannelPlugins in managed settings)`
              : `plugin ${entry.name}@${entry.marketplace} is not on the approved channels allowlist (use --dangerously-load-development-channels for local dev)`,
        }
      }
    }
  } else {
    // server-kind：allowlist schema 为 {marketplace, plugin}，server 条目永远无法匹配。若无此
    // 限制，--channels server:plugin:foo:bar 会匹配 plugin runtime 名称，并绕过 allowlist 注册。
    if (!entry.dev) {
      return {
        action: 'skip',
        kind: 'allowlist',
        reason: `server ${entry.name} is not on the approved channels allowlist (use --dangerously-load-development-channels for local dev)`,
      }
    }
  }

  return { action: 'register' }
}
