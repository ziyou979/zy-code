// 助手聊天模式装配。
// 对应原 root.ts 中 `feature('KAIROS') && pendingAssistantChat` 分支：
// `zy assistant [sessionId]` 以纯查看器客户端连接远程助手会话。
// 代理循环在远程运行；此进程流式传输实时事件并 POST 消息。
// 历史懒加载，由 useAssistantHistory 在滚动向上时加载（无阻塞获取）。

import { setIsRemoteMode } from 'src/bootstrap/runtime/runtimeContext.js'
import { setKairosActive, setUserMsgOptIn } from 'src/bootstrap/runtime/runtimeContext.js'
import { filterCommandsForRemoteMode } from '../../commands.js'
import type { StatsStore } from '../../context/stats.js'
import {
  launchAssistantInstallWizard,
  launchAssistantSessionChooser,
} from '../../DialogLaunchers.js'
import type { Root } from '../../ink.js'
import { exitWithError, exitWithMessage } from '../../InteractiveHelpers.js'
import { createRemoteSessionConfig } from '../../remote/remoteSessionManager.js'
import { prepareApiRequest } from '../../services/teleport/api.js'
import type { AppState } from '../../state/AppStateStore.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import type { Command } from '../../commands/types.js'
import type { FpsMetrics } from '../../utils/fpsTracker.js'
import { gracefulShutdown } from '../../utils/gracefulShutdown.js'
import { createSystemMessage } from '../../services/messages/./constructors.js'
import type { ThinkingConfig } from '../../utils/thinking.js'
import { launchRemoteSessionRepl } from './remoteSession.js'
import type { RenderAndRun } from './types.js'
export interface AssistantChatParams {
  root: Root
  renderAndRun: RenderAndRun
  getFpsMetrics: () => FpsMetrics | undefined
  stats: StatsStore
  initialState: AppState
  pendingAssistantChat: { sessionId?: string; discover?: boolean }
  commands: Command[]
  debug: boolean
  debugToStderr: boolean
  ide: boolean
  mainThreadAgentDefinition: AgentDefinition | undefined
  disableSlashCommands: boolean
  thinkingConfig: ThinkingConfig
}

export async function runAssistantChatMode({
  root,
  renderAndRun,
  getFpsMetrics,
  stats,
  initialState,
  pendingAssistantChat,
  commands,
  debug,
  debugToStderr,
  ide,
  mainThreadAgentDefinition,
  disableSlashCommands,
  thinkingConfig,
}: AssistantChatParams): Promise<void> {
  // biome-ignore lint/suspicious/noExplicitAny: CLI 层类型适配
  const { discoverAssistantSessions } = await import('../../assistant/sessionDiscovery.js' as any)
  let targetSessionId = pendingAssistantChat.sessionId

  // 发现流程 —— 列出桥接环境，过滤会话
  if (!targetSessionId) {
    let sessions
    try {
      sessions = await discoverAssistantSessions()
    } catch (e) {
      return await exitWithError(
        root,
        `Failed to discover sessions: ${e instanceof Error ? e.message : e}`,
        () => gracefulShutdown(1),
      )
    }
    if (sessions.length === 0) {
      let installedDir: string | null
      try {
        installedDir = await launchAssistantInstallWizard(root)
      } catch (e) {
        return await exitWithError(
          root,
          `Assistant installation failed: ${e instanceof Error ? e.message : e}`,
          () => gracefulShutdown(1),
        )
      }
      if (installedDir === null) {
        await gracefulShutdown(0)
        process.exit(0)
      }
      // 守护进程需要几秒钟来启动其 worker 并建立桥接会话，
      // 之后发现流程才能找到它。
      return await exitWithMessage(
        root,
        `Assistant installed in ${installedDir}. The daemon is starting up — run \`zy assistant\` again in a few seconds to connect.`,
        {
          exitCode: 0,
          beforeExit: () => gracefulShutdown(0),
        },
      )
    }
    if (sessions.length === 1) {
      targetSessionId = sessions[0]!.id
    } else {
      const picked = await launchAssistantSessionChooser(root, {
        sessions,
      })
      if (!picked) {
        await gracefulShutdown(0)
        process.exit(0)
      }
      targetSessionId = picked
    }
  }

  // 认证 —— 调用 prepareApiRequest() 一次获取 orgUUID，但使用
  // getAccessToken 闭包获取令牌，以便重新连接获取新鲜令牌。
  const { checkAndRefreshOAuthTokenIfNeeded, getZyAIOAuthTokens } = await import(
    '../../services/auth/auth.js'
  )
  await checkAndRefreshOAuthTokenIfNeeded()
  let apiCreds
  try {
    apiCreds = await prepareApiRequest()
  } catch (e) {
    return await exitWithError(
      root,
      `Error: ${e instanceof Error ? e.message : 'Failed to authenticate'}`,
      () => gracefulShutdown(1),
    )
  }
  const getAccessToken = (): string => getZyAIOAuthTokens()?.accessToken ?? apiCreds.accessToken

  // Brief 模式激活：setKairosActive(true) 满足 isBriefEnabled() 的选择加入
  // 和授权（BriefTool.ts:124-132）。
  setKairosActive(true)
  setUserMsgOptIn(true)
  setIsRemoteMode(true)
  const remoteSessionConfig = createRemoteSessionConfig(
    targetSessionId!,
    getAccessToken,
    apiCreds.orgUUID,
    /* hasInitialPrompt */ false,
    /* viewerOnly */ true,
  )
  const infoMessage = createSystemMessage(
    `Attached to assistant session ${targetSessionId!.slice(0, 8)}…`,
    'info',
  )
  const assistantInitialState: AppState = {
    ...initialState,
    isBriefOnly: true,
    kairosEnabled: false,
    replBridgeEnabled: false,
  }
  const remoteCommands = filterCommandsForRemoteMode(commands)
  await launchRemoteSessionRepl({
    root,
    appProps: { getFpsMetrics, stats, initialState: assistantInitialState },
    renderAndRun,
    config: {
      debug: debug || debugToStderr,
      autoConnectIdeFlag: ide,
      mainThreadAgentDefinition,
      disableSlashCommands,
      thinkingConfig,
    },
    remoteCommands,
    initialMessages: [infoMessage],
    remoteSessionConfig,
  })
}
