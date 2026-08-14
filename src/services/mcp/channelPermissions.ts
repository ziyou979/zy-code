/**
 * 通过 Telegram、iMessage、Discord 等 channel 处理权限提示。
 *
 * 与 `WirePermissionCallbacks` 对应：CC 遇到权限对话框时，也会通过活跃 channel 发送提示，
 * 并让回复与本地 UI、bridge、hook、classifier 竞速；首个 resolver 通过 claim() 获胜。
 *
 * 入站使用结构化事件：server 解析用户的 "yes tbxkq" 回复，并通过
 * notifications/zy/channel/permission 发出 {request_id, behavior}。CC 不会把回复作为文本
 * 接收；批准要求 server 主动发出该特定事件，而非仅转发内容。server 通过声明
 * capabilities.experimental['zy/channel/permission'] 启用。
 *
 * 关于“这是否会让 Zy 自我批准”：批准方是通过 channel 操作的用户，而非 Zy。但信任边界不是
 * 终端，而是 allowlist（zy_harbor_ledger）。受损 channel server 可以在用户未看到提示时伪造
 * "yes <id>"。此风险已接受：受损 channel 本就可无限次注入对话，例如长期社会工程或等待
 * acceptEdits；先注入再自批只会更快，并未增加能力。对话框只能拖慢受损 channel，无法阻止。
 * 参见 PR 讨论 2956440848。
 */

import { jsonStringify } from '../../services/infra/slowOperations.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'

/**
 * GrowthBook runtime gate 与 channels gate（zy_harbor）分离，使 channels 可不携带权限转发
 * 独立发布。默认为 false，无需发布即可切换。useManageMCPConnections 挂载时仅检查一次；
 * 会话中途修改开关要重启才生效。
 */
export function isChannelPermissionRelayEnabled(): boolean {
  return getFeatureValue_CACHED_MAY_BE_STALE('zy_harbor_permissions', false)
}

export type ChannelPermissionResponse = {
  behavior: 'allow' | 'deny'
  /** 回复来源的 channel server，例如 "plugin:telegram:tg"。 */
  fromServer: string
}

export type ChannelPermissionCallbacks = {
  /** 为 request ID 注册 resolver，并返回 unsubscribe。 */
  onResponse(requestId: string, handler: (response: ChannelPermissionResponse) => void): () => void
  /** 根据结构化 channel 事件（notifications/zy/channel/permission）解析 pending 请求。ID
   *  处于 pending 时返回 true；server 已解析用户回复并发出 {request_id, behavior}，此处只在
   *  map 中匹配。 */
  resolve(requestId: string, behavior: 'allow' | 'deny', fromServer: string): boolean
}

/**
 * channel server 应实现的回复格式规范：
 *   /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i
 *
 * 5 个小写字母，不含易与 1/I 混淆的 l；匹配不区分大小写，以适应手机自动纠正。不接受无 ID
 * 的 yes/no，也不允许前后附加闲聊文本。
 *
 * CC 生成 ID 并发送提示；SERVER 解析用户回复，通过 notifications/zy/channel/permission 发出
 * {request_id, behavior}。CC 不再用正则匹配文本。导出此正则，使 plugin 可直接导入而无需复制。
 */
export const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

// 25 字母表：a-z 去掉易与 1/I 混淆的 l；25^5 约有 980 万种组合
const ID_ALPHABET = 'abcdefghijkmnopqrstuvwxyz'

// 子字符串 blocklist：5 个随机字母可能组成不当词汇。列表并不穷尽，只覆盖误发给上级时明显
// 不妥的层级；生成 ID 包含任一项时，加 salt 重新哈希。
// prettier-ignore
const ID_AVOID_SUBSTRINGS = [
  'fuck',
  'shit',
  'cunt',
  'cock',
  'dick',
  'twat',
  'piss',
  'crap',
  'bitch',
  'whore',
  'ass',
  'tit',
  'cum',
  'fag',
  'dyke',
  'nig',
  'kike',
  'rape',
  'nazi',
  'damn',
  'poo',
  'pee',
  'wank',
  'anus',
]

function hashToId(input: string): string {
  // FNV-1a → uint32，再以 base-25 编码。并非加密用途，只需生成稳定的纯字母短 ID。
  // 32 bits / log2(25) 约有 6.9 个字母的熵，截取 5 个虽有少量浪费，但足够使用。
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  h = h >>> 0
  let s = ''
  for (let i = 0; i < 5; i++) {
    s += ID_ALPHABET[h % 25]
    h = Math.floor(h / 25)
  }
  return s
}

/**
 * 根据 toolUseID 生成短 ID：从去掉 l 的 25 字母表中取 5 个字母，因为 l 在多种字体中易与
 * 1/I 混淆。25^5 约有 980 万种组合，达到 50% 生日碰撞概率需约 3000 个同时 pending 的
 * prompt，单个交互会话不可能达到。纯字母使手机用户无需切换键盘模式；若结果包含 blocklist
 * 子字符串，则添加 salt 后重新哈希，避免随机字母组成不宜发送的词。toolUseID 为 `toolu_`
 * 加类似 base64 的内容，因此采用哈希而非截取。
 */
export function shortRequestId(toolUseID: string): string {
  // 7 个长度 3 × 3 个位置 × 25² + 15 个长度 4 × 2 × 25 + 2 个长度 5，约在
  // 980 万 ID 中阻止 13877 个，即约每 700 个命中一次。最多重试 10 次，(1/700)^10 可忽略。
  let candidate = hashToId(toolUseID)
  for (let salt = 0; salt < 10; salt++) {
    if (!ID_AVOID_SUBSTRINGS.some((bad) => candidate.includes(bad))) {
      return candidate
    }
    candidate = hashToId(`${toolUseID}:${salt}`)
  }
  return candidate
}

/**
 * 将 tool 输入截断为适合手机显示的 JSON 预览。200 字符在窄屏手机上约为 3 行。完整输入位于
 * 本地终端对话框；channel 只收到摘要，避免 Write(5KB-file) 淹没消息。server 决定是否及
 * 如何展示。
 */
export function truncateForPreview(input: unknown): string {
  try {
    const s = jsonStringify(input)
    return s.length > 200 ? `${s.slice(0, 200)}…` : s
  } catch {
    return '(unserializable)'
  }
}

/**
 * 筛选出可转发权限提示的 MCP client。必须同时满足三项：已连接、位于会话 --channels
 * allowlist、声明两种 capability。第二种 capability 是 server 的显式 opt-in，使仅转发消息
 * 的 channel 不会意外成为权限入口。集中在此实现，便于未来只在一处添加第四项条件。
 */
export function filterPermissionRelayClients<
  T extends {
    type: string
    name: string
    capabilities?: { experimental?: Record<string, unknown> }
  },
>(clients: readonly T[], isInAllowlist: (name: string) => boolean): (T & { type: 'connected' })[] {
  return clients.filter(
    (c): c is T & { type: 'connected' } =>
      c.type === 'connected' &&
      isInAllowlist(c.name) &&
      c.capabilities?.experimental?.['zy/channel'] !== undefined &&
      c.capabilities?.experimental?.['zy/channel/permission'] !== undefined,
  )
}

/**
 * callback 对象工厂。pending Map 保存在闭包中，不放模块级，也不放 AppState，因为 state 中
 * 的函数会影响相等比较和序列化。生命周期与 `replWirePermissionCallbacks` 相同：每个会话
 * 在 React hook 内构造一次，并将稳定引用存入 AppState。
 *
 * 专用 notification handler（notifications/zy/channel/permission）使用结构化 payload 调用
 * resolve()。server 已将 "yes tbxkq" 解析为 {request_id, behavior}，此处只匹配 pending
 * map。CC 端不使用正则，普通 channel 文本不会意外批准任何请求。
 */
export function createChannelPermissionCallbacks(): ChannelPermissionCallbacks {
  const pending = new Map<string, (response: ChannelPermissionResponse) => void>()

  return {
    onResponse(requestId, handler) {
      // 此处也转为小写，与 resolve() 对称；否则未来调用方传入混合大小写 ID 时会静默无法匹配。
      // shortRequestId 当前始终输出小写，因此暂时是 no-op，但对称处理可明确契约。
      const key = requestId.toLowerCase()
      pending.set(key, handler)
      return () => {
        pending.delete(key)
      }
    },

    resolve(requestId, behavior, fromServer) {
      const key = requestId.toLowerCase()
      const resolver = pending.get(key)
      if (!resolver) {
        return false
      }
      // 调用前先删除；即使 resolver 抛出异常或重入，条目也已移除。同时可处理重复事件：第二次
      // 发出会直接落空，视为 server bug 或网络重复并忽略。
      pending.delete(key)
      resolver({ behavior, fromServer })
      return true
    },
  }
}
