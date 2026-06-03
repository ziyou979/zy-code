// REPL 远程模式聚合：将 useRemoteSession / useDirectConnect / useSSHSession
// 三个远程通道收敛为一个 activeRemote 接口。
//
// 三个 hook 的 Result 类型结构同构（isRemoteMode / sendMessage / cancelRequest /
// disconnect），但分别由不同 transport 驱动：
// - useRemoteSession: WebSocket → CCR（--remote / teleport）
// - useDirectConnect: WebSocket → zy 服务器（zy connect）
// - useSSHSession: ChildProcess stdin/stdout（zy ssh）
//
// activeRemote 取首个 isRemoteMode === true 的 hook，下游统一通过
// `.isRemoteMode / .sendMessage / .cancelRequest` 与之交互。
//
// handleRemoteInit 由 useRemoteSession 在 CCR 初始化握手时回调，
// 根据远程暴露的斜杠命令过滤本地命令列表。

import type React from 'react'
import { useCallback } from 'react'
import { REMOTE_SAFE_COMMANDS } from '../../commands.js'
import type { ToolUseConfirm } from '../../components/permissions/PermissionRequest.js'
import type { SpinnerMode } from '../../components/Spinner.js'
import { useDirectConnect } from '../../hooks/useDirectConnect.js'
import { useRemoteSession } from '../../hooks/useRemoteSession.js'
import { useSSHSession } from '../../hooks/useSSHSession.js'
import type { RemoteSessionConfig } from '../../remote/RemoteSessionManager.js'
import type { DirectConnectConfig } from '../../server/directConnectManager.js'
import type { RemoteMessageContent } from '../../services/teleport/api.js'
import type { SSHSession } from '../../ssh/createSSHSession.js'
import type { Tool } from '../../Tool.js'
import type { Command } from '../../types/command.js'
import type { Message as MessageType } from '../../types/message.js'
import type { StreamingToolUse } from '../../utils/messages.js'

// activeRemote 的统一接口：取三种 transport 的最小公共子集。
// useRemoteSession 的 sendMessage 接受额外 opts，其它两个不接受 —— 联合后
// opts 变可选，符合下游统一调用形态。
export type ActiveRemote = {
  isRemoteMode: boolean
  sendMessage: (content: RemoteMessageContent, opts?: { uuid?: string }) => Promise<boolean>
  cancelRequest: () => void
  disconnect: () => void
}

export type UseReplActiveRemoteParams = {
  remoteSessionConfig: RemoteSessionConfig | undefined
  directConnectConfig: DirectConnectConfig | undefined
  sshSession: SSHSession | undefined
  setMessages: React.Dispatch<React.SetStateAction<MessageType[]>>
  setIsLoading: (loading: boolean) => void
  setToolUseConfirmQueue: React.Dispatch<React.SetStateAction<ToolUseConfirm[]>>
  tools: Tool[]
  setStreamingToolUses: React.Dispatch<React.SetStateAction<StreamingToolUse[]>>
  setStreamMode: (v: SpinnerMode) => void
  setInProgressToolUseIDs: (f: (prev: Set<string>) => Set<string>) => void
  /** CCR 握手返回的远程斜杠命令列表，用于过滤本地命令 */
  setLocalCommands: React.Dispatch<React.SetStateAction<Command[]>>
}

export function useReplActiveRemote({
  remoteSessionConfig,
  directConnectConfig,
  sshSession,
  setMessages,
  setIsLoading,
  setToolUseConfirmQueue,
  tools,
  setStreamingToolUses,
  setStreamMode,
  setInProgressToolUseIDs,
  setLocalCommands,
}: UseReplActiveRemoteParams): ActiveRemote {
  // 根据 CCR 可用斜杠命令过滤命令的回调：保留 CCR 包含的或本地安全集合中的命令
  const handleRemoteInit = useCallback(
    (remoteSlashCommands: string[]) => {
      const remoteCommandSet = new Set(remoteSlashCommands)
      setLocalCommands((prev) =>
        prev.filter((cmd) => remoteCommandSet.has(cmd.name) || REMOTE_SAFE_COMMANDS.has(cmd)),
      )
    },
    [setLocalCommands],
  )

  // 远程会话 hook - 管理 --remote 模式的 WebSocket 连接和消息处理
  const remoteSession = useRemoteSession({
    config: remoteSessionConfig,
    setMessages,
    setIsLoading,
    onInit: handleRemoteInit,
    setToolUseConfirmQueue,
    tools,
    setStreamingToolUses,
    setStreamMode,
    setInProgressToolUseIDs,
  })

  // 直连 hook - 管理到 zy 服务器的 WebSocket 连接，用于 `zy connect` 模式
  const directConnect = useDirectConnect({
    config: directConnectConfig,
    setMessages,
    setIsLoading,
    setToolUseConfirmQueue,
    tools,
  })

  // SSH 会话 hook - 管理 ssh 子进程，用于 `zy ssh` 模式。
  // 与 useDirectConnect 相同的回调形状；仅底层
  // 传输不同（ChildProcess stdin/stdout 与 WebSocket）。
  const sshRemote = useSSHSession({
    session: sshSession,
    setMessages,
    setIsLoading,
    setToolUseConfirmQueue,
    tools,
  })

  // 选用活动的远程模式：sshRemote → directConnect → remoteSession 优先级
  return sshRemote.isRemoteMode
    ? sshRemote
    : directConnect.isRemoteMode
      ? directConnect
      : remoteSession
}
