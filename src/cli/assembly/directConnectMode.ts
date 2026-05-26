// directConnect 模式装配。
// 对应原 root.ts 中 `feature('DIRECT_CONNECT') && pendingConnect?.url` 分支：
// `zy connect <url>` 完整交互式 TUI 连接到远程服务器。

import {
  getOriginalCwd,
  setCwdState,
  setDirectConnectServerUrl,
  setOriginalCwd,
} from '../../bootstrap/state.js'
import { exitWithError } from '../../interactiveHelpers.js'
import { launchRepl } from '../../replLauncher.js'
import {
  createDirectConnectSession,
  DirectConnectError,
} from '../../server/createDirectConnectSession.js'
import { createSystemMessage } from '../../utils/messages.js'
import { gracefulShutdown } from '../../utils/gracefulShutdown.js'
import type { AssemblyContext, SessionConfig } from './types.js'

// 与 cli/argvDispatch.ts:pendingConnect 同形态。
export type PendingDirectConnect = {
  url: string
  authToken?: string
  dangerouslySkipPermissions?: boolean
}

export type DirectConnectModeParams = AssemblyContext & {
  pendingConnect: PendingDirectConnect
  // 从 sessionConfig 复用最少字段：debug、commands、autoConnectIdeFlag、
  // mainThreadAgentDefinition、disableSlashCommands、thinkingConfig。
  // 该分支不复用 initialTools / mcpClients / dynamicMcpConfig / systemPrompt 等。
  config: Pick<
    SessionConfig,
    | 'debug'
    | 'commands'
    | 'autoConnectIdeFlag'
    | 'mainThreadAgentDefinition'
    | 'disableSlashCommands'
    | 'thinkingConfig'
  >
}

export async function runDirectConnectMode({
  root,
  appProps,
  renderAndRun,
  pendingConnect,
  config,
}: DirectConnectModeParams): Promise<void> {
  let directConnectConfig
  try {
    const session = await createDirectConnectSession({
      serverUrl: pendingConnect.url,
      authToken: pendingConnect.authToken,
      cwd: getOriginalCwd(),
      dangerouslySkipPermissions: pendingConnect.dangerouslySkipPermissions,
    })
    if (session.workDir) {
      setOriginalCwd(session.workDir)
      setCwdState(session.workDir)
    }
    setDirectConnectServerUrl(pendingConnect.url)
    directConnectConfig = session.config
  } catch (err) {
    return await exitWithError(
      root,
      err instanceof DirectConnectError ? err.message : String(err),
      () => gracefulShutdown(1),
    )
  }
  const connectInfoMessage = createSystemMessage(
    `Connected to server at ${pendingConnect.url}\nSession: ${directConnectConfig.sessionId}`,
    'info',
  )
  await launchRepl(
    root,
    appProps,
    {
      debug: config.debug,
      commands: config.commands,
      initialTools: [],
      initialMessages: [connectInfoMessage],
      mcpClients: [],
      autoConnectIdeFlag: config.autoConnectIdeFlag,
      mainThreadAgentDefinition: config.mainThreadAgentDefinition,
      disableSlashCommands: config.disableSlashCommands,
      directConnectConfig,
      thinkingConfig: config.thinkingConfig,
    },
    renderAndRun,
  )
}
