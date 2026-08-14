/**
 * bridge 消息处理共享的 transport 层辅助函数。
 *
 * 从 replBridge.ts 提取，使基于环境的核心 initBridgeCore 与无环境层核心
 * initEnvLessWireCore 可以共用入站解析、控制请求处理及回显去重机制。
 *
 * 此处所有逻辑均为纯函数，不闭包捕获 bridge 专属状态。所有协作者（transport、sessionId、UUID
 * 集合、callback）都通过参数传入。
 */

import { randomUUID } from 'node:crypto'
import { logEvent } from '../services/analytics/index.js'
import { EMPTY_USAGE } from '../services/api/emptyUsage.js'
import type { WireMessage, WireResultSuccess } from '../types/index.js'
import type { Message } from '../types/message.js'
import type { WireControlRequest, WireControlResponse } from '../types/wire/control.js'
import { normalizeControlMessageKeys } from '../services/messages/controlMessageCompat.js'
import { logForDebugging } from '../services/infra/debug.js'
import { stripDisplayTagsAllowEmpty } from '../services/messages/xmlTagUtils.js'
import { errorMessage } from '../utils/errors.js'
import type { PermissionMode } from '../services/permissions/permissionMode.js'
import { jsonParse } from '../services/infra/slowOperations.js'
import type { ReplWireTransport } from './replBridgeTransport.js'
// ─── 类型守卫 ───────────────────────────────────────────────────────────────

/** 已解析 WebSocket 消息的类型谓词。WireMessage 是以 `type` 为判别字段的 union；校验该字段
 *  足以构成谓词，调用方再通过 union 进一步缩窄。 */
export function isSDKMessage(value: unknown): value is WireMessage {
  return (
    value !== null && typeof value === 'object' && 'type' in value && typeof value.type === 'string'
  )
}

/** 服务端 control_response 消息的类型谓词。 */
export function isSDKControlResponse(value: unknown): value is WireControlResponse {
  return (
    value !== null &&
    typeof value === 'object' &&
    'type' in value &&
    value.type === 'control_response' &&
    'response' in value
  )
}

/** 服务端 control_request 消息的类型谓词。 */
export function isSDKControlRequest(value: unknown): value is WireControlRequest {
  return (
    value !== null &&
    typeof value === 'object' &&
    'type' in value &&
    value.type === 'control_request' &&
    'request_id' in value &&
    'request' in value
  )
}

/**
 * 对应应转发到 bridge transport 的消息类型时返回 true。服务端只需要 user/assistant turn 与
 * slash command system 事件；tool_result、progress 等其余内容属于 REPL 内部消息。
 */
export function isEligibleWireMessage(m: Message): boolean {
  // 虚拟消息（REPL 内部调用）仅供展示；bridge/SDK 消费方会看到概括任务的 REPL tool_use/result。
  if ((m.type === 'user' || m.type === 'assistant') && m.isVirtual) {
    return false
  }
  return (
    m.type === 'user' ||
    m.type === 'assistant' ||
    (m.type === 'system' && m.subtype === 'local_command')
  )
}

/**
 * 从 Message 中提取适合 onUserMessage 生成标题的文本。以下消息不应作为会话标题，返回
 * undefined：非用户消息、meta（nudge）、tool result、compact summary、非人工来源（task 通知、
 * channel 消息），或仅含展示 tag 的内容（<ide_opened_file>、<session-start-hook> 等）。
 *
 * 此处不筛除合成中断（[Request interrupted by user]），因为 isSyntheticMessage 位于 messages.ts，
 * import 较重且会引入 command 注册表。initReplBridge 的 initialMessages 路径会检查；
 * writeMessages 路径几乎不可能将中断作为首条消息，因为中断意味着此前已有 prompt 流过。
 */
export function extractTitleText(m: Message): string | undefined {
  if (m.type !== 'user' || m.isMeta || m.toolUseResult || m.isCompactSummary) {
    return undefined
  }
  if (m.origin && m.origin.kind !== 'human') {
    return undefined
  }
  const content = m.message.content
  let raw: string | undefined
  if (typeof content === 'string') {
    raw = content
  } else {
    for (const block of content) {
      if (block.type === 'text') {
        raw = block.text
        break
      }
    }
  }
  if (!raw) {
    return undefined
  }
  const clean = stripDisplayTagsAllowEmpty(raw)
  return clean || undefined
}

// ─── 入站路由 ───────────────────────────────────────────────────────────────

/**
 * 解析入站 WebSocket 消息并路由到合适 handler。忽略 UUID 位于 recentPostedUUIDs（本地发送
 * 消息的回显）或 recentInboundUUIDs（已转发消息的重新投递）中的消息，例如更换 transport
 * 丢失 seq-num cursor 后服务端重放历史。
 */
export function handleIngressMessage(
  data: string,
  recentPostedUUIDs: BoundedUUIDSet,
  recentInboundUUIDs: BoundedUUIDSet,
  onInboundMessage: ((msg: WireMessage) => void | Promise<void>) | undefined,
  onPermissionResponse?: ((response: WireControlResponse) => void) | undefined,
  onControlRequest?: ((request: WireControlRequest) => void) | undefined,
): void {
  try {
    const parsed: unknown = normalizeControlMessageKeys(jsonParse(data))

    // control_response 不是 WireMessage，需在类型守卫前检查
    if (isSDKControlResponse(parsed)) {
      logForDebugging('[bridge:repl] Ingress message type=control_response')
      onPermissionResponse?.(parsed)
      return
    }

    // 服务端发来的 control_request（initialize、set_model、can_use_tool）。必须及时响应，否则
    // 服务端会在约 10 至 14 秒超时后终止 WS。
    if (isSDKControlRequest(parsed)) {
      logForDebugging(`[bridge:repl] Inbound control_request subtype=${parsed.request.subtype}`)
      onControlRequest?.(parsed)
      return
    }

    if (!isSDKMessage(parsed)) {
      return
    }

    // 检查 UUID，以识别本地消息的回显
    const uuid = 'uuid' in parsed && typeof parsed.uuid === 'string' ? parsed.uuid : undefined

    if (uuid && recentPostedUUIDs.has(uuid)) {
      logForDebugging(`[bridge:repl] Ignoring echo: type=${parsed.type} uuid=${uuid}`)
      return
    }

    // 防御性去重：丢弃已转发的入站 prompt。延续 SSE seq-num（lastTransportSequenceNum）是解决
    // 历史重放的主要措施；此处捕获协商失败的边界情况，例如服务端忽略 from_sequence_num、
    // transport 在收到任何帧前失效等。
    if (uuid && recentInboundUUIDs.has(uuid)) {
      logForDebugging(
        `[bridge:repl] Ignoring re-delivered inbound: type=${parsed.type} uuid=${uuid}`,
      )
      return
    }

    logForDebugging(
      `[bridge:repl] Ingress message type=${parsed.type}${uuid ? ` uuid=${uuid}` : ''}`,
    )

    if (parsed.type === 'user') {
      if (uuid) {
        recentInboundUUIDs.add(uuid)
      }
      logEvent('zy_bridge_message_received', {
        is_repl: true,
      })
      // fire-and-forget；handler 可能因解析 attachment 而异步运行。
      void onInboundMessage?.(parsed)
    } else {
      logForDebugging(`[bridge:repl] Ignoring non-user inbound message: type=${parsed.type}`)
    }
  } catch (err) {
    logForDebugging(`[bridge:repl] Failed to parse ingress message: ${errorMessage(err)}`)
  }
}

// ─── 服务端发起的控制请求 ───────────────────────────────────────────────────

export type ServerControlRequestHandlers = {
  transport: ReplWireTransport | null
  sessionId: string
  /**
   * 为 true 时，所有可变请求（interrupt、set_model、set_permission_mode、
   * set_max_thinking_tokens）都返回错误，而非假成功。initialize 仍返回成功，否则服务端会终止
   * 连接。用于仅出站 bridge 模式与 SDK 的 /bridge 子路径，使 zy.ai 显示正确错误，而非“操作成功
   * 但本地没有变化”。
   */
  outboundOnly?: boolean
  onInterrupt?: () => void
  onSetModel?: (model: string | undefined) => void
  onSetMaxThinkingTokens?: (maxTokens: number | null) => void
  onSetPermissionMode?: (mode: PermissionMode) => { ok: true } | { ok: false; error: string }
}

const OUTBOUND_ONLY_ERROR =
  'This session is outbound-only. Enable Remote Control locally to allow inbound control.'

/**
 * 响应服务端入站 control_request。服务端会为会话生命周期事件（initialize、set_model）及
 * turn 级协调（interrupt、set_max_thinking_tokens）发送这些请求。若不响应，服务端会挂起并在
 * 约 10 至 14 秒后终止 WS。
 *
 * 此前是 initBridgeCore 的 onWorkReceived 内部闭包；现通过参数接收协作者，供两个核心共用。
 */
export function handleServerControlRequest(
  request: WireControlRequest,
  handlers: ServerControlRequestHandlers,
): void {
  const {
    transport,
    sessionId,
    outboundOnly,
    onInterrupt,
    onSetModel,
    onSetMaxThinkingTokens,
    onSetPermissionMode,
  } = handlers
  if (!transport) {
    logForDebugging('[bridge:repl] Cannot respond to control_request: transport not configured')
    return
  }

  let response: WireControlResponse

  // 仅出站模式：可变请求返回错误，避免 zy.ai 显示假成功。initialize 仍必须成功，否则服务端会
  // 终止连接，参见上方说明。
  if (outboundOnly && request.request.subtype !== 'initialize') {
    response = {
      type: 'control_response',
      response: {
        subtype: 'error',
        request_id: request.request_id,
        error: OUTBOUND_ONLY_ERROR,
      },
    }
    const event = { ...response, session_id: sessionId }
    void transport.write(event)
    logForDebugging(
      `[bridge:repl] Rejected ${request.request.subtype} (outbound-only) request_id=${request.request_id}`,
    )
    return
  }

  switch (request.request.subtype) {
    case 'initialize':
      // 只响应最小能力；command、model 与账户信息由 REPL 自行处理。
      response = {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: request.request_id,
          response: {
            commands: [],
            output_style: 'normal',
            available_output_styles: ['normal'],
            models: [],
            account: {},
            pid: process.pid,
          },
        },
      }
      break

    case 'set_model':
      onSetModel?.(request.request.model)
      response = {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: request.request_id,
        },
      }
      break

    case 'set_max_thinking_tokens':
      onSetMaxThinkingTokens?.(request.request.max_thinking_tokens)
      response = {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: request.request_id,
        },
      }
      break

    case 'set_permission_mode': {
      // callback 返回策略 verdict，使此处无需 import isAutoModeGateEnabled /
      // isBypassPermissionsModeDisabled 即可发送错误 control_response，以保持 bootstrap 隔离。
      // 若未注册 callback（daemon context 不绑定，参见 daemonBridge.ts），则返回错误 verdict，
      // 而非静默假成功；该 context 中模式实际不会应用，返回成功会误导 client。
      // biome-ignore lint/suspicious/noExplicitAny: 适配层处理 SDK 扩展字段
      const verdict = onSetPermissionMode?.(request.request.mode as PermissionMode) ?? {
        ok: false,
        error:
          'set_permission_mode is not supported in this context (onSetPermissionMode callback not registered)',
      }
      if (verdict.ok) {
        response = {
          type: 'control_response',
          response: {
            subtype: 'success',
            request_id: request.request_id,
          },
        }
      } else {
        response = {
          type: 'control_response',
          response: {
            subtype: 'error',
            request_id: request.request_id,
            error: verdict.error,
          },
        }
      }
      break
    }

    case 'interrupt':
      onInterrupt?.()
      response = {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: request.request_id,
        },
      }
      break

    default:
      // 未知 subtype 返回错误，避免服务端因等待永远不会到来的响应而挂起。
      response = {
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id: request.request_id,
          error: `REPL bridge does not handle control_request subtype: ${request.request.subtype}`,
        },
      }
  }

  const event = { ...response, session_id: sessionId }
  void transport.write(event)
  logForDebugging(
    `[bridge:repl] Sent control_response for ${request.request.subtype} request_id=${request.request_id} result=${response.response.subtype}`,
  )
}

// ─── Result 消息（供 teardown 时归档会话）───────────────────────────────────

/**
 * 构建供会话归档使用的最小 `WireResultSuccess` 消息。服务端需要在 WS 关闭前收到此事件，
 * 才会触发归档。
 */
export function makeResultMessage(sessionId: string): WireResultSuccess {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 0,
    duration_api_ms: 0,
    isError: false,
    num_turns: 0,
    result: '',
    stop_reason: null,
    total_cost_usd: 0,
    usage: { ...EMPTY_USAGE },
    modelUsage: {},
    permission_denials: [],
    session_id: sessionId,
    uuid: randomUUID(),
  }
}

// ─── BoundedUUIDSet（回显去重环形缓冲区）────────────────────────────────────

/**
 * 由环形缓冲区实现、采用 FIFO 上限的集合。达到容量时淘汰最早项，使内存占用稳定为 O(capacity)。
 *
 * 消息按时间顺序加入，因此淘汰项始终最早。调用方以外部顺序（hook 的 lastWrittenIndexRef）作为
 * 主要去重依据；此集合是回显过滤与竞争去重的第二道安全网。
 */
export class BoundedUUIDSet {
  private readonly capacity: number
  private readonly ring: (string | undefined)[]
  private readonly set = new Set<string>()
  private writeIdx = 0

  constructor(capacity: number) {
    this.capacity = capacity
    this.ring = new Array<string | undefined>(capacity)
  }

  add(uuid: string): void {
    if (this.set.has(uuid)) {
      return
    }
    // 淘汰当前写入位置的已有项
    const evicted = this.ring[this.writeIdx]
    if (evicted !== undefined) {
      this.set.delete(evicted)
    }
    this.ring[this.writeIdx] = uuid
    this.set.add(uuid)
    this.writeIdx = (this.writeIdx + 1) % this.capacity
  }

  has(uuid: string): boolean {
    return this.set.has(uuid)
  }

  clear(): void {
    this.set.clear()
    this.ring.fill(undefined)
    this.writeIdx = 0
  }
}
