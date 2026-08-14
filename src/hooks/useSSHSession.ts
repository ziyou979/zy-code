/**
 * `zy ssh` 会话的 REPL 集成 hook。
 *
 * 与 useDirectConnect 同级，具有相同结构（isRemoteMode/sendMessage/
 * cancelRequest/disconnect）和相同 REPL 接线，但驱动 SSH child process 而非 WebSocket。
 * 没有将其泛化进 useDirectConnect，因为生命周期不同：ssh 进程和 auth proxy
 * 在此 hook 运行前（启动期间的 main.tsx 中）创建并传入；useDirectConnect
 * 则在 effect 内创建 WebSocket。
 */

import { randomUUID } from 'node:crypto'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { ToolUseConfirm } from '../components/permissions/PermissionRequest.js'
import { convertSDKMessage, isSessionEndMessage } from '../remote/messageAdapter.js'
import {
  createSyntheticAssistantMessage,
  createToolStub,
} from '../remote/remotePermissionBridge.js'
import type { RemoteMessageContent } from '../services/teleport/api.js'
import type { SSHSession } from '../ssh/createSSHSession.js'
// @ts-expect-error
import type { SSHSessionManager } from '../ssh/sshSessionManager.js'
import type { Tool } from '../tools/tool.js'
import { findToolByName } from '../tools/tool.js'
import type { Message as MessageType } from '../types/message.js'
import type { PermissionAskDecision } from '../types/permissions.js'
import { logForDebugging } from '../services/infra/debug.js'
import { gracefulShutdown } from '../bootstrap/lifecycle/gracefulShutdown.js'

type UseSSHSessionResult = {
  isRemoteMode: boolean
  sendMessage: (content: RemoteMessageContent) => Promise<boolean>
  cancelRequest: () => void
  disconnect: () => void
}

type UseSSHSessionProps = {
  session: SSHSession | undefined
  setMessages: React.Dispatch<React.SetStateAction<MessageType[]>>
  setIsLoading: (loading: boolean) => void
  setToolUseConfirmQueue: React.Dispatch<React.SetStateAction<ToolUseConfirm[]>>
  tools: Tool[]
}

export function useSSHSession({
  session,
  setMessages,
  setIsLoading,
  setToolUseConfirmQueue,
  tools,
}: UseSSHSessionProps): UseSSHSessionResult {
  const isRemoteMode = !!session

  const managerRef = useRef<SSHSessionManager | null>(null)
  const hasReceivedInitRef = useRef(false)
  const isConnectedRef = useRef(false)

  const toolsRef = useRef(tools)
  useEffect(() => {
    toolsRef.current = tools
  }, [tools])

  useEffect(() => {
    if (!session) {
      return
    }

    hasReceivedInitRef.current = false
    logForDebugging('[useSSHSession] wiring SSH session manager')

    const manager = session.createManager({
      // biome-ignore lint/suspicious/noExplicitAny: 钩子系统动态类型处理
      onMessage: (sdkMessage: any) => {
        if (isSessionEndMessage(sdkMessage)) {
          setIsLoading(false)
        }

        // 跳过重复的 init 消息（stream-json 模式每轮一条）。
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
      // biome-ignore lint/suspicious/noExplicitAny: 钩子系统动态类型处理
      onPermissionRequest: (request: any, requestId: any) => {
        logForDebugging(`[useSSHSession] permission request: ${request.tool_name}`)

        const tool =
          findToolByName(toolsRef.current, request.tool_name) ?? createToolStub(request.tool_name)

        const syntheticMessage = createSyntheticAssistantMessage(request, requestId)

        const permissionResult: PermissionAskDecision = {
          behavior: 'ask',
          message: request.description ?? `${request.tool_name} requires permission`,
          suggestions: request.permission_suggestions,
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
          onUserInteraction() {},
          onAbort() {
            manager.respondToPermissionRequest(requestId, {
              behavior: 'deny',
              message: 'User aborted',
            })
            setToolUseConfirmQueue((q) => q.filter((i) => i.toolUseID !== request.tool_use_id))
          },
          onAllow(updatedInput) {
            manager.respondToPermissionRequest(requestId, {
              behavior: 'allow',
              updatedInput,
            })
            setToolUseConfirmQueue((q) => q.filter((i) => i.toolUseID !== request.tool_use_id))
            setIsLoading(true)
          },
          onReject(feedback) {
            manager.respondToPermissionRequest(requestId, {
              behavior: 'deny',
              message: feedback ?? 'User denied permission',
            })
            setToolUseConfirmQueue((q) => q.filter((i) => i.toolUseID !== request.tool_use_id))
          },
          async recheckPermission() {},
        }

        setToolUseConfirmQueue((q) => [...q, toolUseConfirm])
        setIsLoading(false)
      },
      onConnected: () => {
        logForDebugging('[useSSHSession] connected')
        isConnectedRef.current = true
      },
      onReconnecting: (attempt: number, max: number) => {
        logForDebugging(`[useSSHSession] ssh dropped, reconnecting (${attempt}/${max})`)
        isConnectedRef.current = false
        // 在 transcript 中显示临时 system 消息，让用户知道当前状况；
        // 下次 onConnected 会清除此状态。进行中的请求会丢失；remote 的 --continue
        // 会重新加载历史，但没有进行中的轮次可恢复。
        setIsLoading(false)
        const msg: MessageType = {
          type: 'system',
          subtype: 'informational',
          content: `SSH connection dropped — reconnecting (attempt ${attempt}/${max})...`,
          timestamp: new Date().toISOString(),
          uuid: randomUUID(),
          level: 'warning',
        }
        setMessages((prev) => [...prev, msg])
      },
      onDisconnected: () => {
        logForDebugging('[useSSHSession] ssh process exited (giving up)')
        const stderr = session.getStderrTail().trim()
        const connected = isConnectedRef.current
        const exitCode = session.proc.exitCode
        isConnectedRef.current = false
        setIsLoading(false)

        let msg = connected ? 'Remote session ended.' : 'SSH session failed before connecting.'
        // remote stderr 看起来像错误时显示：连接前始终显示；连接后仅在非零退出时显示，
        // 否则只是普通的 --verbose 噪声。
        if (stderr && (!connected || exitCode !== 0)) {
          msg += `\nRemote stderr (exit ${exitCode ?? `signal ${session.proc.signalCode}`}):\n${stderr}`
        }
        void gracefulShutdown(1, 'other', { finalMessage: msg })
      },
      onError: (error: Error) => {
        logForDebugging(`[useSSHSession] error: ${error.message}`)
      },
    })

    managerRef.current = manager
    manager.connect()

    return () => {
      logForDebugging('[useSSHSession] cleanup')
      manager.disconnect()
      session.proxy.stop()
      managerRef.current = null
    }
  }, [session, setMessages, setIsLoading, setToolUseConfirmQueue])

  const sendMessage = useCallback(
    async (content: RemoteMessageContent): Promise<boolean> => {
      const m = managerRef.current
      if (!m) {
        return false
      }
      setIsLoading(true)
      return m.sendMessage(content)
    },
    [setIsLoading],
  )

  const cancelRequest = useCallback(() => {
    managerRef.current?.sendInterrupt()
    setIsLoading(false)
  }, [setIsLoading])

  const disconnect = useCallback(() => {
    managerRef.current?.disconnect()
    managerRef.current = null
    isConnectedRef.current = false
  }, [])

  return useMemo(
    () => ({ isRemoteMode, sendMessage, cancelRequest, disconnect }),
    [isRemoteMode, sendMessage, cancelRequest, disconnect],
  )
}
