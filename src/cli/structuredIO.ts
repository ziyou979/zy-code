import { feature } from 'bun:bundle'
import { randomUUID } from 'node:crypto'
import type { ElicitResult, JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import type { AssistantMessage } from 'src/types/message.js'
import type { CanUseToolFn } from 'src/hooks/useCanUseTool.js'
import type { Tool, ToolUseContext } from 'src/tools/tool.js'
import { type HookCallback, hookJSONOutputSchema } from 'src/types/hooks/index.js'
import type {
  HookInput,
  HookJSONOutput,
  PermissionUpdate,
  WireMessage,
  WireUserMessage,
} from 'src/types/index.js'
import type {
  StdinMessage,
  StdoutMessage,
  WireControlRequest,
  WireControlResponse,
} from 'src/types/wire/control.js'
import { WireControlElicitationResponseSchema } from 'src/types/wire/controlSchemas.js'
import { logForDebugging } from 'src/services/infra/debug.js'
import { logForDiagnosticsNoPII } from 'src/services/telemetry/diagLogs.js'
import { AbortError } from 'src/utils/errors.js'
import {
  type Output as PermissionToolOutput,
  permissionPromptToolResultToPermissionDecision,
  outputSchema as permissionToolOutputSchema,
} from 'src/services/permissions/permissionPromptToolResultSchema.js'
import type { PermissionDecision, PermissionDecisionReason } from 'src/types/permissions.js'
import { hasPermissionsToUseTool } from 'src/services/permissions/permissions.js'
import { writeToStdout } from 'src/services/shell/process.js'
import { jsonStringify } from 'src/services/infra/slowOperations.js'
import { z } from 'zod/v4'
import { notifyCommandLifecycle } from '../services/hooks/commandLifecycle.js'
import { normalizeControlMessageKeys } from '../services/messages/controlMessageCompat.js'
import {
  notifySessionStateChanged,
  type RequiresActionDetails,
  type SessionExternalMetadata,
} from '../services/session-state/sessionState.js'
import { jsonParse } from '../services/infra/slowOperations.js'
import { Stream } from '../utils/stream.js'
import { ndjsonSafeStringify } from './ndjsonSafeStringify.js'
import { executePermissionRequestHooksForSDK } from './sdkPermissionBridge.js'

/**
 * 通过 can_use_tool control_request 协议转发 sandbox 网络权限请求时使用的合成 tool 名称。
 * SDK host 会将其视为普通 tool 权限 prompt。
 */
export const SANDBOX_NETWORK_ACCESS_TOOL_NAME = 'SandboxNetworkAccess'

function serializeDecisionReason(reason: PermissionDecisionReason | undefined): string | undefined {
  if (!reason) {
    return undefined
  }

  if (reason.type === 'classifier') {
    return reason.reason
  }
  switch (reason.type) {
    case 'rule':
    case 'mode':
    case 'subcommandResults':
    case 'permissionPromptTool':
      return undefined
    case 'hook':
    case 'asyncAgent':
    case 'sandboxOverride':
    case 'workingDir':
    case 'safetyCheck':
    case 'other':
      return reason.reason
  }
}

function buildRequiresActionDetails(
  tool: Tool,
  input: Record<string, unknown>,
  toolUseID: string,
  requestId: string,
): RequiresActionDetails {
  // 各 tool 的 summary 方法可能因输入格式错误而抛错；权限处理不能因错误描述中断。
  let description: string
  try {
    description =
      tool.getActivityDescription?.(input) ??
      tool.getToolUseSummary?.(input) ??
      tool.userFacingName(input)
  } catch {
    description = tool.name
  }
  return {
    tool_name: tool.name,
    action_description: description,
    toolCallId: toolUseID,
    request_id: requestId,
    input,
  }
}

type PendingRequest<T> = {
  resolve: (result: T) => void
  reject: (error: unknown) => void
  schema?: z.Schema
  request: WireControlRequest
}

/**
 * 提供从 stdio 读写 SDK 消息的结构化方式，并封装 SDK 协议。
 */
// 最多跟踪的已解决 tool_use ID 数量。超过后淘汰最早项，限制超长会话的内存占用，同时保留
// 足够历史以识别重复 control_response 投递。
const MAX_RESOLVED_TOOL_USE_IDS = 1000

export class StructuredIO {
  readonly structuredInput: AsyncGenerator<StdinMessage | WireMessage>
  private readonly pendingRequests = new Map<string, PendingRequest<unknown>>()

  // worker 启动时读回的 CCR external_metadata；transport 未恢复时为 null。由 RemoteIO 赋值。
  restoredWorkerState: Promise<SessionExternalMetadata | null> = Promise.resolve(null)

  private inputClosed = false
  private unexpectedResponseCallback?: (response: WireControlResponse) => Promise<void>

  // 跟踪已通过正常权限流程解决或被 hook 中止的 tool_use ID。原始响应处理完成后若收到重复
  // control_response，该 Set 可防止孤立 handler 再次处理；否则会向 mutableMessages 加入重复
  // assistant 消息，导致 API 返回 400 “tool_use ids must be unique”。
  private readonly resolvedToolUseIds = new Set<string>()
  private prependedLines: string[] = []
  private onControlRequestSent?: (request: WireControlRequest) => void
  private onControlRequestResolved?: (requestId: string) => void

  // sendRequest() 与 print.ts 都在此入队，drain 循环是唯一写入方，防止 control_request 越过
  // 已排队的 stream_event。
  readonly outbound = new Stream<StdoutMessage>()

  constructor(
    private readonly input: AsyncIterable<string>,
    private readonly replayUserMessages?: boolean,
  ) {
    this.input = input
    this.structuredInput = this.read()
  }

  /**
   * 将 tool_use ID 记录为已解决，使孤立 handler 忽略同一 tool 的迟到或重复 control_response。
   */
  private trackResolvedToolUseId(request: WireControlRequest): void {
    if (request.request.subtype === 'can_use_tool') {
      this.resolvedToolUseIds.add(request.request.tool_use_id)
      if (this.resolvedToolUseIds.size > MAX_RESOLVED_TOOL_USE_IDS) {
        // 淘汰最早项；Set 按插入顺序迭代
        const first = this.resolvedToolUseIds.values().next().value
        if (first !== undefined) {
          this.resolvedToolUseIds.delete(first)
        }
      }
    }
  }

  /** flush 待处理的内部事件。非远程 IO 不操作，由 RemoteIO 覆盖。 */
  flushInternalEvents(): Promise<void> {
    return Promise.resolve()
  }

  /** 内部事件队列深度。由 RemoteIO 覆盖，其他情况为零。 */
  get internalEventsPending(): number {
    return 0
  }

  /**
   * 将一个用户 turn 排队，使其在 this.input 的下一条消息前 yield。迭代开始前与流传输中途均可
   * 使用；read() 会在每次 yield 消息之间重新检查 prependedLines。
   */
  prependUserMessage(content: string): void {
    this.prependedLines.push(
      `${jsonStringify({
        type: 'user',
        session_id: '',
        message: { role: 'user', content: [{ type: 'text' as const, text: content }] },
        parent_tool_use_id: null,
      } satisfies WireUserMessage)}\n`,
    )
  }

  private async *read() {
    let content = ''

    // 在 for-await 前调用一次，否则 this.input 为空时会完全跳过循环体；随后每个 block 再调用。
    // prependedLines 的复查位于 while 内，因此即使在同一 block 两条消息之间插入，也会优先返回。
    const splitAndProcess = async function* (this: StructuredIO) {
      for (;;) {
        if (this.prependedLines.length > 0) {
          content = this.prependedLines.join('') + content
          this.prependedLines = []
        }
        const newline = content.indexOf('\n')
        if (newline === -1) {
          break
        }
        const line = content.slice(0, newline)
        content = content.slice(newline + 1)
        const message = await this.processLine(line)
        if (message) {
          logForDiagnosticsNoPII('info', 'cli_stdin_message_parsed', {
            type: message.type,
          })
          yield message
        }
      }
    }.bind(this)

    yield* splitAndProcess()

    for await (const block of this.input) {
      content += block
      yield* splitAndProcess()
    }
    if (content) {
      const message = await this.processLine(content)
      if (message) {
        yield message
      }
    }
    this.inputClosed = true
    for (const request of this.pendingRequests.values()) {
      // 输入流结束时拒绝所有待处理请求
      request.reject(new Error('Tool permission stream closed before response received'))
    }
  }

  getPendingPermissionRequests() {
    return Array.from(this.pendingRequests.values())
      .map((entry) => entry.request)
      .filter((pr) => pr.request.subtype === 'can_use_tool')
  }

  setUnexpectedResponseCallback(callback: (response: WireControlResponse) => Promise<void>): void {
    this.unexpectedResponseCallback = callback
  }

  /**
   * 注入 control_response 消息以解决待处理的权限请求。bridge 用它将 zy.ai 的权限响应送入
   * SDK 权限流程。
   *
   * 同时向 SDK 消费方发送 control_cancel_request，使其 canUseTool callback 通过 signal 中止；
   * 否则 callback 会挂起。
   */
  injectControlResponse(response: WireControlResponse): void {
    const requestId = response.response?.request_id
    if (!requestId) {
      return
    }
    const request = this.pendingRequests.get(requestId)
    if (!request) {
      return
    }
    this.trackResolvedToolUseId(request.request)
    this.pendingRequests.delete(requestId)
    // 取消 SDK 消费方的 canUseTool callback；本次竞争由 bridge 胜出。
    void this.write({
      type: 'control_cancel_request',
      request_id: requestId,
    })
    if (response.response.subtype === 'error') {
      request.reject(new Error(response.response.error))
    } else {
      const result = response.response.response
      if (request.schema) {
        try {
          request.resolve(request.schema.parse(result))
        } catch (error) {
          request.reject(error)
        }
      } else {
        request.resolve({})
      }
    }
  }

  /**
   * 注册 callback，每当 can_use_tool control_request 写入 stdout 时调用。bridge 用它将权限
   * 请求转发到 zy.ai。
   */
  setOnControlRequestSent(callback: ((request: WireControlRequest) => void) | undefined): void {
    this.onControlRequestSent = callback
  }

  /**
   * 注册 callback，当 SDK 消费方通过 stdin 传入 can_use_tool control_response 时调用。SDK
   * 消费方在竞争中胜出时，bridge 用它取消 zy.ai 上的陈旧权限 prompt。
   */
  setOnControlRequestResolved(callback: ((requestId: string) => void) | undefined): void {
    this.onControlRequestResolved = callback
  }

  private async processLine(line: string): Promise<StdinMessage | WireMessage | undefined> {
    // 跳过空行，例如管道 stdin 中的连续换行
    if (!line) {
      return undefined
    }
    try {
      const message = normalizeControlMessageKeys(jsonParse(line)) as StdinMessage | WireMessage
      if (message.type === 'keep_alive') {
        // 静默忽略 keep-alive 消息
        return undefined
      }
      if (message.type === 'update_environment_variables') {
        // 直接将环境变量更新应用到 process.env。bridge session runner 用它刷新认证 token
        //（ZY_CODE_SESSION_ACCESS_TOKEN）；该变量必须能由 REPL 进程自身读取，而不只是子 Bash
        // command。
        const keys = Object.keys(message.variables)
        for (const [key, value] of Object.entries(message.variables)) {
          process.env[key] = value
        }
        logForDebugging(`[structuredIO] applied update_environment_variables: ${keys.join(', ')}`)
        return undefined
      }
      if (message.type === 'control_response') {
        // 关闭每个 control_response 的生命周期，包括重复与孤立响应。孤立响应不会 yield 到
        // print.ts 主循环，因此这是唯一能看到它们的路径。uuid 由服务端注入 payload。
        const uuid =
          'uuid' in message && typeof message.uuid === 'string' ? message.uuid : undefined
        if (uuid) {
          notifyCommandLifecycle(uuid, 'completed')
        }
        const request = this.pendingRequests.get(message.response.request_id)
        if (!request) {
          // 检查此 tool_use 是否已通过正常权限流程解决。重复 control_response 投递（例如来自
          // WebSocket 重连）会在原始响应处理后到达，再次处理会向对话加入重复 assistant 消息，
          // 导致 API 返回 400。
          const responsePayload =
            message.response.subtype === 'success' ? message.response.response : undefined
          const toolUseID = responsePayload?.toolUseID
          if (typeof toolUseID === 'string' && this.resolvedToolUseIds.has(toolUseID)) {
            logForDebugging(
              `Ignoring duplicate control_response for already-resolved toolUseID=${toolUseID} request_id=${message.response.request_id}`,
            )
            return undefined
          }
          if (this.unexpectedResponseCallback) {
            await this.unexpectedResponseCallback(message)
          }
          return undefined // Ignore responses for requests we don't know about
        }
        this.trackResolvedToolUseId(request.request)
        this.pendingRequests.delete(message.response.request_id)
        // SDK 消费方解决 can_use_tool 请求时通知 bridge，使其取消 zy.ai 上的陈旧权限 prompt。
        if (request.request.request.subtype === 'can_use_tool' && this.onControlRequestResolved) {
          this.onControlRequestResolved(message.response.request_id)
        }

        if (message.response.subtype === 'error') {
          request.reject(new Error(message.response.error))
          return undefined
        }
        const result = message.response.response
        if (request.schema) {
          try {
            request.resolve(request.schema.parse(result))
          } catch (error) {
            request.reject(error)
          }
        } else {
          request.resolve({})
        }
        // 启用 replay 时传播 control response
        if (this.replayUserMessages) {
          return message
        }
        return undefined
      }
      if (
        message.type !== 'user' &&
        message.type !== 'control_request' &&
        message.type !== 'assistant' &&
        message.type !== 'system'
      ) {
        logForDebugging(`Ignoring unknown message type: ${message.type}`, {
          level: 'warn',
        })
        return undefined
      }
      if (message.type === 'control_request') {
        if (!message.request) {
          exitWithMessage(`Error: Missing request on control_request`)
        }
        return message
      }
      if (message.type === 'assistant' || message.type === 'system') {
        return message
      }
      const userRole = (message.message as { role?: unknown }).role
      if (userRole !== 'user') {
        exitWithMessage(`Error: Expected message role 'user', got '${String(userRole)}'`)
      }
      return message
    } catch (error) {
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.error(`Error parsing streaming input line: ${line}: ${error}`)
      // eslint-disable-next-line custom-rules/no-process-exit
      process.exit(1)
    }
  }

  async write(message: StdoutMessage): Promise<void> {
    writeToStdout(`${ndjsonSafeStringify(message)}\n`)
  }

  private async sendRequest<Response>(
    request: WireControlRequest['request'],
    schema: z.Schema,
    signal?: AbortSignal,
    requestId: string = randomUUID(),
  ): Promise<Response> {
    const message: WireControlRequest = {
      type: 'control_request',
      request_id: requestId,
      request,
    }
    if (this.inputClosed) {
      throw new Error('Stream closed')
    }
    if (signal?.aborted) {
      throw new Error('Request aborted')
    }
    this.outbound.enqueue(message)
    if (request.subtype === 'can_use_tool' && this.onControlRequestSent) {
      this.onControlRequestSent(message)
    }
    const aborted = () => {
      this.outbound.enqueue({
        type: 'control_cancel_request',
        request_id: requestId,
      })
      // 立即拒绝未完成 promise，不等待 host 确认取消。
      const request = this.pendingRequests.get(requestId)
      if (request) {
        // 拒绝前将 tool_use ID 标记为已解决，使孤立 handler 忽略 host 的迟到响应。
        this.trackResolvedToolUseId(request.request)
        request.reject(new AbortError())
      }
    }
    if (signal) {
      signal.addEventListener('abort', aborted, {
        once: true,
      })
    }
    try {
      return await new Promise<Response>((resolve, reject) => {
        this.pendingRequests.set(requestId, {
          request: {
            type: 'control_request',
            request_id: requestId,
            request,
          },
          resolve: (result) => {
            resolve(result as Response)
          },
          reject,
          schema,
        })
      })
    } finally {
      if (signal) {
        signal.removeEventListener('abort', aborted)
      }
      this.pendingRequests.delete(requestId)
    }
  }

  createCanUseTool(onPermissionPrompt?: (details: RequiresActionDetails) => void): CanUseToolFn {
    return async (
      tool: Tool,
      input: { [key: string]: unknown },
      toolUseContext: ToolUseContext,
      assistantMessage: AssistantMessage,
      toolUseID: string,
      forceDecision?: PermissionDecision,
    ): Promise<PermissionDecision> => {
      const mainPermissionResult =
        forceDecision ??
        (await hasPermissionsToUseTool(tool, input, toolUseContext, assistantMessage, toolUseID))
      // tool 已允许或拒绝时返回结果
      if (mainPermissionResult.behavior === 'allow' || mainPermissionResult.behavior === 'deny') {
        return mainPermissionResult
      }

      // 并行运行 PermissionRequest hook 与 SDK 权限 prompt。终端 CLI 中 hook 会与交互式 prompt
      // 竞争，使带 --delay 20 的 hook 等不会阻塞 UI。此处需要相同行为：SDK host（VS Code 等）
      // 立即显示权限对话框，同时 hook 在后台运行。先完成者胜出，另一方被取消或忽略。

      // 若 hook 先作出决定，使用 AbortController 取消 SDK 请求
      const hookAbortController = new AbortController()
      const parentSignal = toolUseContext.abortController.signal
      // 将父级 abort 转发到本地 controller
      const onParentAbort = () => hookAbortController.abort()
      parentSignal.addEventListener('abort', onParentAbort, { once: true })

      try {
        // 启动 hook 评估，在后台运行
        const hookPromise = executePermissionRequestHooksForSDK(
          tool.name,
          toolUseID,
          input,
          toolUseContext,
          mainPermissionResult.suggestions,
        ).then((decision) => ({ source: 'hook' as const, decision }))

        // 立即启动 SDK 权限 prompt，不等待 hook
        const requestId = randomUUID()
        onPermissionPrompt?.(buildRequiresActionDetails(tool, input, toolUseID, requestId))
        const sdkPromise = this.sendRequest<PermissionToolOutput>(
          {
            subtype: 'can_use_tool',
            tool_name: tool.name,
            input,
            permission_suggestions: mainPermissionResult.suggestions,
            blocked_path: mainPermissionResult.blockedPath,
            decision_reason: serializeDecisionReason(mainPermissionResult.decisionReason),
            tool_use_id: toolUseID,
            agent_id: toolUseContext.agentId,
          },
          permissionToolOutputSchema(),
          hookAbortController.signal,
          requestId,
        ).then((result) => ({ source: 'sdk' as const, result }))

        // 让 hook 完成与 SDK prompt 响应竞争。hook promise 始终完成而不会拒绝；没有 hook 作出决定时
        // 返回 undefined。
        const winner = await Promise.race([hookPromise, sdkPromise])

        if (winner.source === 'hook') {
          if (winner.decision) {
            // hook 已决定，中止待处理 SDK 请求，并抑制 sdkPromise 预期的 AbortError rejection。
            sdkPromise.catch(() => {})
            hookAbortController.abort()
            return winner.decision
          }
          // hook 未作决定，等待 SDK prompt
          const sdkResult = await sdkPromise
          return permissionPromptToolResultToPermissionDecision(
            sdkResult.result,
            tool,
            input,
            toolUseContext,
          )
        }

        // SDK prompt 先响应，使用其结果；hook 仍在后台运行，但结果会被忽略
        return permissionPromptToolResultToPermissionDecision(
          winner.result,
          tool,
          input,
          toolUseContext,
        )
      } catch (error) {
        return permissionPromptToolResultToPermissionDecision(
          {
            behavior: 'deny',
            message: `Tool permission request failed: ${error}`,
            toolUseID,
          },
          tool,
          input,
          toolUseContext,
        )
      } finally {
        // 仅当没有其他待处理权限 prompt 时恢复为 'running'；并发 tool 执行可能同时有多个请求。
        if (this.getPendingPermissionRequests().length === 0) {
          notifySessionStateChanged('running')
        }
        parentSignal.removeEventListener('abort', onParentAbort)
      }
    }
  }

  createHookCallback(callbackId: string, timeout?: number): HookCallback {
    return {
      type: 'callback',
      timeout,
      callback: async (
        input: HookInput,
        toolUseID: string | null,
        abort: AbortSignal | undefined,
      ): Promise<HookJSONOutput> => {
        try {
          const result = await this.sendRequest<HookJSONOutput>(
            {
              subtype: 'hook_callback',
              callback_id: callbackId,
              input,
              tool_use_id: toolUseID || undefined,
            },
            hookJSONOutputSchema(),
            abort,
          )
          return result
        } catch (error) {
          // biome-ignore lint/suspicious/noConsole:: intentional console output
          console.error(`Error in hook callback ${callbackId}:`, error)
          return {}
        }
      },
    }
  }

  /**
   * 向 SDK 消费方发送 elicitation 请求并返回响应。
   */
  async handleElicitation(
    serverName: string,
    message: string,
    requestedSchema?: Record<string, unknown>,
    signal?: AbortSignal,
    mode?: 'form' | 'url',
    url?: string,
    elicitationId?: string,
  ): Promise<ElicitResult> {
    try {
      const result = await this.sendRequest<ElicitResult>(
        {
          subtype: 'elicitation',
          mcp_server_name: serverName,
          message,
          mode,
          url,
          elicitation_id: elicitationId,
          requested_schema: requestedSchema,
        },
        WireControlElicitationResponseSchema(),
        signal,
      )
      return result
    } catch {
      return { action: 'cancel' as const }
    }
  }

  /**
   * 创建 SandboxAskCallback，将 sandbox 网络权限请求作为 can_use_tool control_request 转发到
   * SDK host。
   *
   * 通过合成 tool 名称复用现有 can_use_tool 协议，使 SDK host（VS Code、CCR 等）无需新增协议
   * subtype 即可向用户询问网络访问权限。
   */
  createSandboxAskCallback(): (hostPattern: { host: string; port?: number }) => Promise<boolean> {
    return async (hostPattern): Promise<boolean> => {
      try {
        const result = await this.sendRequest<PermissionToolOutput>(
          {
            subtype: 'can_use_tool',
            tool_name: SANDBOX_NETWORK_ACCESS_TOOL_NAME,
            input: { host: hostPattern.host },
            tool_use_id: randomUUID(),
            description: `Allow network connection to ${hostPattern.host}?`,
          },
          permissionToolOutputSchema(),
        )
        return result.behavior === 'allow'
      } catch {
        // 请求失败（流关闭、abort 等）时拒绝连接
        return false
      }
    }
  }

  /**
   * 向 SDK server 发送 MCP 消息并等待响应。
   */
  async sendMcpMessage(serverName: string, message: JSONRPCMessage): Promise<JSONRPCMessage> {
    const response = await this.sendRequest<{ mcp_response: JSONRPCMessage }>(
      {
        subtype: 'mcp_message',
        server_name: serverName,
        message,
      },
      z.object({
        mcp_response: z.any() as z.Schema<JSONRPCMessage>,
      }),
    )
    return response.mcp_response
  }
}

function exitWithMessage(message: string): never {
  // biome-ignore lint/suspicious/noConsole:: intentional console output
  console.error(message)
  // eslint-disable-next-line custom-rules/no-process-exit
  process.exit(1)
}
