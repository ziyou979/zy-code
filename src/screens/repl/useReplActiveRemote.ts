// REPL 远程模式聚合：将 useDirectConnect / useSSHSession
// 两个远程通道收敛为一个 activeRemote 接口。
//
// 两个 hook 的 Result 类型结构同构（isRemoteMode / sendMessage / cancelRequest /
// disconnect），但分别由不同 transport 驱动：
// - useDirectConnect: WebSocket → zy 服务器（zy connect）
// - useSSHSession: ChildProcess stdin/stdout（zy ssh）
//
// activeRemote 取首个 isRemoteMode === true 的 hook，下游统一通过
// `.isRemoteMode / .sendMessage / .cancelRequest` 与之交互。

import type React from 'react'
import type { ToolUseConfirm } from '../../components/permissions/PermissionRequest.js'
import type { SpinnerMode } from '../../types/spinner.js'
import { useDirectConnect } from '../../hooks/useDirectConnect.js'
import { useSSHSession } from '../../hooks/useSSHSession.js'
import type { DirectConnectConfig } from '../../server/directConnectManager.js'
import type { RemoteMessageContent } from '../../remote/messageAdapter.js'
import type { SSHSession } from '../../ssh/createSSHSession.js'
import type { Tool } from '../../tools/tool.js'
import type { Message as MessageType } from '../../types/message.js'
import { StreamingToolUse } from '../../services/messages/./streaming.js'

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
  directConnectConfig: DirectConnectConfig | undefined
  sshSession: SSHSession | undefined
  setMessages: React.Dispatch<React.SetStateAction<MessageType[]>>
  setIsLoading: (loading: boolean) => void
  setToolUseConfirmQueue: React.Dispatch<React.SetStateAction<ToolUseConfirm[]>>
  tools: Tool[]
  setStreamingToolUses: React.Dispatch<React.SetStateAction<StreamingToolUse[]>>
  setStreamMode: (v: SpinnerMode) => void
  setInProgressToolUseIDs: (f: (prev: Set<string>) => Set<string>) => void
}

export function useReplActiveRemote({
  directConnectConfig,
  sshSession,
  setMessages,
  setIsLoading,
  setToolUseConfirmQueue,
  tools,
  setStreamingToolUses,
  setStreamMode,
  setInProgressToolUseIDs,
}: UseReplActiveRemoteParams): ActiveRemote {
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

  // 选用活动的远程模式：sshRemote → directConnect 优先级
  return sshRemote.isRemoteMode ? sshRemote : directConnect
}
