import { useCallback, useEffect, useMemo, useRef } from 'react'
import { BoundedUUIDSet } from '../bridge/bridgeMessaging.js'
import type { ToolUseConfirm } from '../components/permissions/PermissionRequest.js'
import type { SpinnerMode } from '../types/spinner.js'
import { convertSDKMessage, isSessionEndMessage } from '../remote/messageAdapter.js'
import {
  type RemotePermissionResponse,
  type RemoteSessionConfig,
  RemoteSessionManager,
} from '../remote/remoteSessionManager.js'
import {
  createSyntheticAssistantMessage,
  createToolStub,
} from '../remote/remotePermissionBridge.js'
import type { RemoteMessageContent } from '../services/teleport/api.js'
import { updateSessionTitle } from '../services/teleport/api.js'
import { useSetAppState } from '../state/AppState.js'
import type { AppState } from '../state/AppStateStore.js'
import type { Tool } from '../tools/tool.js'
import { findToolByName } from '../tools/tool.js'
import type { Message as MessageType } from '../types/message.js'
import type { PermissionAskDecision, PermissionUpdate } from '../types/permissions.js'
import { logForDebugging } from '../services/infra/debug.js'
import { truncateToWidth } from '../utils/format.js'
import { createSystemMessage } from '../services/messages/./constructors.js'
import { extractTextContent } from '../services/messages/./predicates.js'
import { handleMessageFromStream } from '../services/messages/./streaming.js'
import type { StreamingToolUse } from '../services/messages/./streaming.js'
import { generateSessionTitle } from '../services/session-storage/sessionTitle.js'

// 显示警告前等待响应的时长
const RESPONSE_TIMEOUT_MS = 60000 // 60 seconds
// compaction 期间延长超时：compact API 调用需要 5-30 秒且会阻塞其他 SDK 消息，
// compaction 本身接近上限时，常规 60 秒超时并不够用。
const COMPACTION_TIMEOUT_MS = 180000 // 3 minutes

type UseRemoteSessionProps = {
  config: RemoteSessionConfig | undefined
  setMessages: React.Dispatch<React.SetStateAction<MessageType[]>>
  setIsLoading: (loading: boolean) => void
  onInit?: (slashCommands: string[]) => void
  setToolUseConfirmQueue: React.Dispatch<React.SetStateAction<ToolUseConfirm[]>>
  tools: Tool[]
  setStreamingToolUses?: React.Dispatch<React.SetStateAction<StreamingToolUse[]>>
  setStreamMode?: (v: SpinnerMode) => void
  setInProgressToolUseIDs?: (f: (prev: Set<string>) => Set<string>) => void
}

type UseRemoteSessionResult = {
  isRemoteMode: boolean
  sendMessage: (content: RemoteMessageContent, opts?: { uuid?: string }) => Promise<boolean>
  cancelRequest: () => void
  disconnect: () => void
}

/**
 * 在 REPL 中管理 remote CCR 会话的 hook。
 *
 * 负责：
 * - 建立到 CCR 的 WebSocket 连接
 * - 将 SDK 消息转换为 REPL 消息
 * - 通过 HTTP POST 将用户输入发送到 CCR
 * - 通过现有 ToolUseConfirm 队列处理权限请求/响应流程
 */
export function useRemoteSession({
  config,
  setMessages,
  setIsLoading,
  onInit,
  setToolUseConfirmQueue,
  tools,
  setStreamingToolUses,
  setStreamMode,
  setInProgressToolUseIDs,
}: UseRemoteSessionProps): UseRemoteSessionResult {
  const isRemoteMode = !!config

  const setAppState = useSetAppState()
  const setConnStatus = useCallback(
    (s: AppState['remoteConnectionStatus']) =>
      setAppState((prev) =>
        prev.remoteConnectionStatus === s ? prev : { ...prev, remoteConnectionStatus: s },
      ),
    [setAppState],
  )

  // remote daemon child 内运行中 subagent 的事件溯源计数。viewer 自身的 AppState.tasks
  // 为空，任务位于另一进程；task_started/task_notification 通过 bridge WS 到达。
  const runningTaskIdsRef = useRef(new Set<string>())
  const writeTaskCount = useCallback(() => {
    const n = runningTaskIdsRef.current.size
    setAppState((prev) =>
      prev.remoteBackgroundTaskCount === n ? prev : { ...prev, remoteBackgroundTaskCount: n },
    )
  }, [setAppState])

  // 检测会话卡住的定时器
  const responseTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  // 跟踪 remote 会话是否正在 compact。compaction 期间 CLI worker 忙于 API 调用，
  // 会暂时停止发送消息；此时使用更长超时，避免误报“无响应”。
  const isCompactingRef = useRef(false)

  const managerRef = useRef<RemoteSessionManager | null>(null)

  // 跟踪无 initial prompt 会话是否已更新标题
  const hasUpdatedTitleRef = useRef(false)

  // UUIDs of user messages we POSTed locally — the WS echoes them back and
  // we must filter them out when convertUserTextMessages is on, or the viewer
  // sees every typed message twice (once from local createUserMessage, once
  // from the echo). A single POST can echo MULTIPLE times with the same uuid:
  // the server may broadcast the POST directly to /subscribe, AND the worker
  // (cowork desktop / CLI daemon) echoes it again on its write path. A
  // delete-on-first-match Set would let the second echo through — use a
  // bounded ring instead. Cap is generous: users don't type 50 messages
  // faster than echoes arrive.
  // NOTE: this does NOT dedup history-vs-live overlap at attach time (nothing
  // seeds the set from history UUIDs; only sendMessage populates it).
  const sentUUIDsRef = useRef(new BoundedUUIDSet(50))

  // 用 ref 保存 tools，避免 WebSocket callback 捕获旧值
  const toolsRef = useRef(tools)
  useEffect(() => {
    toolsRef.current = tools
  }, [tools])

  // 初始化并连接 remote 会话
  useEffect(() => {
    // 非 remote 模式时跳过
    if (!config) {
      return
    }

    logForDebugging(`[useRemoteSession] Initializing for session ${config.sessionId}`)

    const manager = new RemoteSessionManager(config, {
      onMessage: (sdkMessage) => {
        const parts = [`type=${sdkMessage.type}`]
        if ('subtype' in sdkMessage) {
          parts.push(`subtype=${sdkMessage.subtype}`)
        }
        if (sdkMessage.type === 'user') {
          const c = sdkMessage.message?.content
          parts.push(`content=${Array.isArray(c) ? c.map((b) => b.type).join(',') : typeof c}`)
        }
        logForDebugging(`[useRemoteSession] Received ${parts.join(' ')}`)

        // Clear response timeout on any message received — including the WS
        // echo of our own POST, which acts as a heartbeat. This must run
        // BEFORE the echo filter, or slow-to-stream agents (compaction, cold
        // start) spuriously trip the 60s unresponsive warning + reconnect.
        if (responseTimeoutRef.current) {
          clearTimeout(responseTimeoutRef.current)
          responseTimeoutRef.current = null
        }

        // Echo filter: drop user messages we already added locally before POST.
        // The server and/or worker round-trip our own send back on the WS with
        // the same uuid we passed to sendEventToRemoteSession. DO NOT delete on
        // match — the same uuid can echo more than once (server broadcast +
        // worker echo), and BoundedUUIDSet already caps growth via its ring.
        if (
          sdkMessage.type === 'user' &&
          sdkMessage.uuid &&
          sentUUIDsRef.current.has(sdkMessage.uuid)
        ) {
          logForDebugging(`[useRemoteSession] Dropping echoed user message ${sdkMessage.uuid}`)
          return
        }
        // 处理 init 消息，提取可用 slash command
        if (sdkMessage.type === 'system' && sdkMessage.subtype === 'init' && onInit) {
          logForDebugging(
            `[useRemoteSession] Init received with ${sdkMessage.slash_commands.length} slash commands`,
          )
          onInit(sdkMessage.slash_commands)
        }

        // Track remote subagent lifecycle for the "N in background" counter.
        // All task types (Agent/teammate/workflow/bash) flow through
        // registerTask() → task_started, and complete via task_notification.
        // Return early — these are status signals, not renderable messages.
        if (sdkMessage.type === 'system') {
          if (sdkMessage.subtype === 'task_started') {
            runningTaskIdsRef.current.add(sdkMessage.task_id)
            writeTaskCount()
            return
          }
          if (sdkMessage.subtype === 'task_notification') {
            runningTaskIdsRef.current.delete(sdkMessage.task_id)
            writeTaskCount()
            return
          }
          if (sdkMessage.subtype === 'task_progress') {
            return
          }
          // Track compaction state. The CLI emits status='compacting' at
          // the start and status=null when done; compact_boundary also
          // signals completion. Repeated 'compacting' status messages
          // (keep-alive ticks) update the ref but don't append to messages.
          if (sdkMessage.subtype === 'status') {
            const wasCompacting = isCompactingRef.current
            isCompactingRef.current = sdkMessage.status === 'compacting'
            if (wasCompacting && isCompactingRef.current) {
              return
            }
          }
          if (sdkMessage.subtype === 'compact_boundary') {
            isCompactingRef.current = false
          }
        }

        // 检查会话是否结束
        if (isSessionEndMessage(sdkMessage)) {
          isCompactingRef.current = false
          setIsLoading(false)
        }

        // Clear in-progress tool_use IDs when their tool_result arrives.
        // Must read the RAW sdkMessage: in non-viewerOnly mode,
        // convertSDKMessage returns {type:'ignored'} for user messages, so the
        // delete would never fire post-conversion. Mirrors the add site below
        // and inProcessRunner.ts; without this the set grows unbounded for the
        // session lifetime (BQ: CCR cohort shows 5.2x higher RSS slope).
        if (setInProgressToolUseIDs && sdkMessage.type === 'user') {
          const content = sdkMessage.message?.content
          if (Array.isArray(content)) {
            const resultIds: string[] = []
            for (const block of content) {
              if (block.type === 'tool_result') {
                resultIds.push(block.toolCallId)
              }
            }
            if (resultIds.length > 0) {
              setInProgressToolUseIDs((prev) => {
                const next = new Set(prev)
                for (const id of resultIds) {
                  next.delete(id)
                }
                return next.size === prev.size ? prev : next
              })
            }
          }
        }

        // Convert SDK message to REPL message. In viewerOnly mode, the
        // remote agent runs BriefTool (SendUserMessage) — its tool_use block
        // renders empty (userFacingName() === ''), actual content is in the
        // tool_result. So we must convert tool_results to render them.
        const converted = convertSDKMessage(
          sdkMessage,
          config.viewerOnly
            ? { convertToolResults: true, convertUserTextMessages: true }
            : undefined,
        )

        if (converted.type === 'message') {
          // When we receive a complete message, clear streaming tool uses
          // since the complete message replaces the partial streaming state
          setStreamingToolUses?.((prev) => (prev.length > 0 ? [] : prev))

          // Mark tool_use blocks as in-progress so the UI shows the correct
          // spinner state instead of "Waiting…" (queued). In local sessions,
          // toolOrchestration.ts handles this, but remote sessions receive
          // pre-built assistant messages without running local tool execution.
          if (setInProgressToolUseIDs && converted.message.type === 'assistant') {
            const toolUseIds = converted.message.message.content
              .filter(
                (block): block is import('../types/llm.js').ToolCallBlock =>
                  block.type === 'tool_call',
              )
              .map((block) => block.id)
            if (toolUseIds.length > 0) {
              setInProgressToolUseIDs((prev) => {
                const next = new Set(prev)
                for (const id of toolUseIds) {
                  next.add(id)
                }
                return next
              })
            }
          }

          setMessages((prev) => [...prev, converted.message])
          // Note: Don't stop loading on assistant messages - the agent may still be
          // working (tool use loops). Loading stops only on session end or permission request.
        } else if (converted.type === 'stream_event') {
          // Process streaming events to update UI in real-time
          if (setStreamingToolUses && setStreamMode) {
            handleMessageFromStream(
              converted.event,
              (message) => setMessages((prev) => [...prev, message]),
              () => {
                // No-op for response length - remote sessions don't track this
              },
              setStreamMode,
              setStreamingToolUses,
            )
          } else {
            logForDebugging(
              `[useRemoteSession] Stream event received but streaming callbacks not provided`,
            )
          }
        }
        // 静默丢弃 'ignored' 消息
      },
      onPermissionRequest: (request, requestId) => {
        logForDebugging(`[useRemoteSession] Permission request for tool: ${request.tool_name}`)

        // 按名称查找 Tool 对象；未知 tool 则创建 stub
        const tool =
          findToolByName(toolsRef.current, request.tool_name) ?? createToolStub(request.tool_name)

        const syntheticMessage = createSyntheticAssistantMessage(request, requestId)

        const permissionResult: PermissionAskDecision = {
          behavior: 'ask',
          message: request.description ?? `${request.tool_name} requires permission`,
          suggestions: request.permission_suggestions as PermissionUpdate[] | undefined,
          blockedPath: request.blocked_path,
        }

        const toolUseConfirm: ToolUseConfirm = {
          assistantMessage: syntheticMessage,
          tool,
          description: request.description ?? `${request.tool_name} requires permission`,
          input: request.input,
          toolUseContext: {} as ToolUseConfirm['toolUseContext'],
          toolUseID: request.tool_use_id,
          permissionResult,
          permissionPromptStartTimeMs: Date.now(),
          onUserInteraction() {
            // remote 模式无需处理，classifier 在 container 上运行
          },
          onAbort() {
            const response: RemotePermissionResponse = {
              behavior: 'deny',
              message: 'User aborted',
            }
            manager.respondToPermissionRequest(requestId, response)
            setToolUseConfirmQueue((queue) =>
              queue.filter((item) => item.toolUseID !== request.tool_use_id),
            )
          },
          onAllow(updatedInput, _permissionUpdates, _feedback) {
            const response: RemotePermissionResponse = {
              behavior: 'allow',
              updatedInput,
            }
            manager.respondToPermissionRequest(requestId, response)
            setToolUseConfirmQueue((queue) =>
              queue.filter((item) => item.toolUseID !== request.tool_use_id),
            )
            // 批准后恢复加载指示器
            setIsLoading(true)
          },
          onReject(feedback?: string) {
            const response: RemotePermissionResponse = {
              behavior: 'deny',
              message: feedback ?? 'User denied permission',
            }
            manager.respondToPermissionRequest(requestId, response)
            setToolUseConfirmQueue((queue) =>
              queue.filter((item) => item.toolUseID !== request.tool_use_id),
            )
          },
          async recheckPermission() {
            // remote 模式无需处理，权限状态位于 container
          },
        }

        setToolUseConfirmQueue((queue) => [...queue, toolUseConfirm])
        // 等待权限期间暂停加载指示器
        setIsLoading(false)
      },
      onPermissionCancelled: (requestId, toolUseId) => {
        logForDebugging(`[useRemoteSession] Permission request cancelled: ${requestId}`)
        const idToRemove = toolUseId ?? requestId
        setToolUseConfirmQueue((queue) => queue.filter((item) => item.toolUseID !== idToRemove))
        setIsLoading(true)
      },
      onConnected: () => {
        logForDebugging('[useRemoteSession] Connected')
        setConnStatus('connected')
      },
      onReconnecting: () => {
        logForDebugging('[useRemoteSession] Reconnecting')
        setConnStatus('reconnecting')
        // WS gap = we may miss task_notification events. Clear rather than
        // drift high forever. Undercounts tasks that span the gap; accepted.
        runningTaskIdsRef.current.clear()
        writeTaskCount()
        // Same for tool_use IDs: missed tool_result during the gap would
        // leave stale spinner state forever.
        setInProgressToolUseIDs?.((prev) => (prev.size > 0 ? new Set() : prev))
      },
      onDisconnected: () => {
        logForDebugging('[useRemoteSession] Disconnected')
        setConnStatus('disconnected')
        setIsLoading(false)
        runningTaskIdsRef.current.clear()
        writeTaskCount()
        setInProgressToolUseIDs?.((prev) => (prev.size > 0 ? new Set() : prev))
      },
      onError: (error) => {
        logForDebugging(`[useRemoteSession] Error: ${error.message}`)
      },
    })

    managerRef.current = manager
    manager.connect()

    return () => {
      logForDebugging('[useRemoteSession] Cleanup - disconnecting')
      // 清除待处理的超时
      if (responseTimeoutRef.current) {
        clearTimeout(responseTimeoutRef.current)
        responseTimeoutRef.current = null
      }
      manager.disconnect()
      managerRef.current = null
    }
  }, [
    config,
    setMessages,
    setIsLoading,
    onInit,
    setToolUseConfirmQueue,
    setStreamingToolUses,
    setStreamMode,
    setInProgressToolUseIDs,
    setConnStatus,
    writeTaskCount,
  ])

  // 向 remote 会话发送用户消息
  const sendMessage = useCallback(
    async (content: RemoteMessageContent, opts?: { uuid?: string }): Promise<boolean> => {
      const manager = managerRef.current
      if (!manager) {
        logForDebugging('[useRemoteSession] Cannot send - no manager')
        return false
      }

      // 清除已有超时
      if (responseTimeoutRef.current) {
        clearTimeout(responseTimeoutRef.current)
      }

      setIsLoading(true)

      // Track locally-added message UUIDs so the WS echo can be filtered.
      // Must record BEFORE the POST to close the race where the echo arrives
      // before the POST promise resolves.
      if (opts?.uuid) {
        sentUUIDsRef.current.add(opts.uuid)
      }

      const success = await manager.sendMessage(content, opts)

      if (!success) {
        // No need to undo the pre-POST add — BoundedUUIDSet's ring evicts it.
        setIsLoading(false)
        return false
      }

      // Update the session title after the first message when no initial prompt was provided.
      // This gives the session a meaningful title on zy.ai instead of "Background task".
      // Skip in viewerOnly mode — the remote agent owns the session title.
      if (!hasUpdatedTitleRef.current && config && !config.hasInitialPrompt && !config.viewerOnly) {
        hasUpdatedTitleRef.current = true
        const sessionId = config.sessionId
        // Extract plain text from content (may be string or content block array)
        const description = typeof content === 'string' ? content : extractTextContent(content, ' ')
        if (description) {
          // generateSessionTitle never rejects (wraps body in try/catch,
          // returns null on failure), so no .catch needed on this chain.
          void generateSessionTitle(description, new AbortController().signal).then((title) => {
            void updateSessionTitle(sessionId, title ?? truncateToWidth(description, 75))
          })
        }
      }

      // Start timeout to detect stuck sessions. Skip in viewerOnly mode —
      // the remote agent may be idle-shut and take >60s to respawn.
      // Use a longer timeout when the remote session is compacting, since
      // the CLI worker is busy with an API call and won't emit messages.
      if (!config?.viewerOnly) {
        const timeoutMs = isCompactingRef.current ? COMPACTION_TIMEOUT_MS : RESPONSE_TIMEOUT_MS
        responseTimeoutRef.current = setTimeout(
          (setMessages, manager) => {
            logForDebugging('[useRemoteSession] Response timeout - attempting reconnect')
            // Add a warning message to the conversation
            const warningMessage = createSystemMessage(
              'Remote session may be unresponsive. Attempting to reconnect…',
              'warning',
            )
            setMessages((prev) => [...prev, warningMessage])

            // Attempt to reconnect the WebSocket - the subscription may have become stale
            manager.reconnect()
          },
          timeoutMs,
          setMessages,
          manager,
        )
      }

      return success
    },
    [config, setIsLoading, setMessages],
  )

  // 取消 remote 会话上的当前请求
  const cancelRequest = useCallback(() => {
    // 清除待处理的超时
    if (responseTimeoutRef.current) {
      clearTimeout(responseTimeoutRef.current)
      responseTimeoutRef.current = null
    }

    // Send interrupt signal to CCR. Skip in viewerOnly mode — Ctrl+C
    // should never interrupt the remote agent.
    if (!config?.viewerOnly) {
      managerRef.current?.cancelSession()
    }

    setIsLoading(false)
  }, [config, setIsLoading])

  // 断开会话连接
  const disconnect = useCallback(() => {
    // 清除待处理的超时
    if (responseTimeoutRef.current) {
      clearTimeout(responseTimeoutRef.current)
      responseTimeoutRef.current = null
    }
    managerRef.current?.disconnect()
    managerRef.current = null
  }, [])

  // All four fields are already stable (boolean derived from a prop that
  // doesn't change mid-session, three useCallbacks with stable deps). The
  // result object is consumed by REPL's onSubmit useCallback deps — without
  // memoization the fresh literal invalidates onSubmit on every REPL render,
  // which in turn churns PromptInput's props and downstream memoization.
  return useMemo(
    () => ({ isRemoteMode, sendMessage, cancelRequest, disconnect }),
    [isRemoteMode, sendMessage, cancelRequest, disconnect],
  )
}
