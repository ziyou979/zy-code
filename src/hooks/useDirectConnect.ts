import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { ToolUseConfirm } from '../components/permissions/PermissionRequest.js'
import { convertSDKMessage, isSessionEndMessage } from '../remote/messageAdapter.js'
import type { RemotePermissionResponse } from '../remote/remoteSessionManager.js'
import {
  createSyntheticAssistantMessage,
  createToolStub,
} from '../remote/remotePermissionBridge.js'
import {
  type DirectConnectConfig,
  DirectConnectSessionManager,
} from '../server/directConnectManager.js'
import type { RemoteMessageContent } from '../services/teleport/api.js'
import type { Tool, ToolUseContext } from '../tools/tool.js'
import { findToolByName } from '../tools/tool.js'
import type { Message as MessageType } from '../types/message.js'
import type { PermissionAskDecision, PermissionUpdate } from '../types/permissions.js'
import { logForDebugging } from '../services/infra/debug.js'
import { gracefulShutdown } from '../bootstrap/lifecycle/gracefulShutdown.js'

type UseDirectConnectResult = {
  isRemoteMode: boolean
  sendMessage: (content: RemoteMessageContent) => Promise<boolean>
  cancelRequest: () => void
  disconnect: () => void
}

type UseDirectConnectProps = {
  config: DirectConnectConfig | undefined
  setMessages: React.Dispatch<React.SetStateAction<MessageType[]>>
  setIsLoading: (loading: boolean) => void
  setToolUseConfirmQueue: React.Dispatch<React.SetStateAction<ToolUseConfirm[]>>
  tools: Tool[]
}

export function useDirectConnect({
  config,
  setMessages,
  setIsLoading,
  setToolUseConfirmQueue,
  tools,
}: UseDirectConnectProps): UseDirectConnectResult {
  const isRemoteMode = !!config

  const managerRef = useRef<DirectConnectSessionManager | null>(null)
  const hasReceivedInitRef = useRef(false)
  const isConnectedRef = useRef(false)

  // 用 ref 保存 tools，避免 WebSocket 回调捕获旧值
  const toolsRef = useRef(tools)
  useEffect(() => {
    toolsRef.current = tools
  }, [tools])

  useEffect(() => {
    if (!config) {
      return
    }

    hasReceivedInitRef.current = false
    logForDebugging(`[useDirectConnect] Connecting to ${config.wsUrl}`)

    const manager = new DirectConnectSessionManager(config, {
      onMessage: (sdkMessage) => {
        if (isSessionEndMessage(sdkMessage)) {
          setIsLoading(false)
        }

        // 跳过重复的 init 消息（服务端每轮都会发送一条）
        if (sdkMessage.type === 'system' && sdkMessage.subtype === 'init') {
          if (hasReceivedInitRef.current) {
            return
          }
          hasReceivedInitRef.current = true
        }

        const converted = convertSDKMessage(sdkMessage, {
          convertToolResults: true,
        })
        if (converted.type === 'message') {
          setMessages((prev) => [...prev, converted.message])
        }
      },
      onPermissionRequest: (request, requestId) => {
        logForDebugging(`[useDirectConnect] Permission request for tool: ${request.tool_name}`)

        const tool =
          findToolByName(toolsRef.current, request.tool_name) ?? createToolStub(request.tool_name)

        const syntheticMessage = createSyntheticAssistantMessage(request, requestId)

        const permissionResult: PermissionAskDecision = {
          behavior: 'ask',
          message: request.description ?? `${request.tool_name} requires permission`,
          suggestions: request.permission_suggestions as PermissionUpdate[] | undefined,
          blockedPath: request.blocked_path,
        }

        const toolUseConfirm = {
          assistantMessage: syntheticMessage,
          permissionUpdates: [] as PermissionUpdate[],
          tool,
          description: request.description ?? `${request.tool_name} requires permission`,
          input: request.input,
          toolUseContext: {} as ToolUseContext,
          toolUseID: request.tool_use_id,
          permissionResult,
          permissionPromptStartTimeMs: Date.now(),
          onUserInteraction() {
            // remote 模式无需处理
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
          onAllow(
            updatedInput: Record<string, unknown>,
            _permissionUpdates: unknown[],
            _feedback?: string,
          ) {
            const response: RemotePermissionResponse = {
              behavior: 'allow',
              updatedInput,
            }
            manager.respondToPermissionRequest(requestId, response)
            setToolUseConfirmQueue((queue) =>
              queue.filter((item) => item.toolUseID !== request.tool_use_id),
            )
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
            // remote 模式无需处理
          },
        }

        setToolUseConfirmQueue((queue) => [...queue, toolUseConfirm])
        setIsLoading(false)
      },
      onConnected: () => {
        logForDebugging('[useDirectConnect] Connected')
        isConnectedRef.current = true
      },
      onDisconnected: () => {
        logForDebugging('[useDirectConnect] Disconnected')
        if (!isConnectedRef.current) {
          // 从未连接成功，说明连接失败（例如认证被拒）
          process.stderr.write(`\nFailed to connect to server at ${config.wsUrl}\n`)
        } else {
          // 连接成功后又断开，说明服务端进程已退出或网络中断
          process.stderr.write('\nServer disconnected.\n')
        }
        isConnectedRef.current = false
        void gracefulShutdown(1)
        setIsLoading(false)
      },
      onError: (error) => {
        logForDebugging(`[useDirectConnect] Error: ${error.message}`)
      },
    })

    managerRef.current = manager
    manager.connect()

    return () => {
      logForDebugging('[useDirectConnect] Cleanup - disconnecting')
      manager.disconnect()
      managerRef.current = null
    }
  }, [config, setMessages, setIsLoading, setToolUseConfirmQueue])

  const sendMessage = useCallback(
    async (content: RemoteMessageContent): Promise<boolean> => {
      const manager = managerRef.current
      if (!manager) {
        return false
      }

      setIsLoading(true)

      return manager.sendMessage(content)
    },
    [setIsLoading],
  )

  // 取消当前请求
  const cancelRequest = useCallback(() => {
    // 向服务端发送中断信号
    managerRef.current?.sendInterrupt()

    setIsLoading(false)
  }, [setIsLoading])

  const disconnect = useCallback(() => {
    managerRef.current?.disconnect()
    managerRef.current = null
    isConnectedRef.current = false
  }, [])

  // 与 useRemoteSession 一样需要保持引用稳定：用 memo 缓存结果，
  // 避免依赖该对象的调用方每次渲染都看到新引用。
  return useMemo(
    () => ({ isRemoteMode, sendMessage, cancelRequest, disconnect }),
    [isRemoteMode, sendMessage, cancelRequest, disconnect],
  )
}
