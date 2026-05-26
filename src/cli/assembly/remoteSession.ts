// 远程会话 REPL 装配。
// 服务 coordinatorRemote（assistant）与 bridge（--remote / teleport）两条路径，
// 它们的 launchRepl 形态高度一致：
// initialTools/[] + mcpClients/[] + 远程过滤后的 commands + remoteSessionConfig。
// 抽出 helper 避免维护两份相同的 launchRepl 调用。
//
// 不抽 discovery / OAuth / wizard 等前置流程：那部分与各自模式深度耦合
// （assistantModule / sessionDiscovery / teleport / bridge），强行外提收益小、回归面大。

import { launchRepl } from '../../replLauncher.js'
import type { RemoteSessionConfig } from '../../remote/RemoteSessionManager.js'
import type { Props as REPLProps } from '../../screens/REPL.js'
import type { Message as MessageType } from '../../types/message.js'
import type { AssemblyContext, SessionConfig } from './types.js'

export type RemoteSessionParams = AssemblyContext & {
  config: Pick<
    SessionConfig,
    | 'debug'
    | 'autoConnectIdeFlag'
    | 'mainThreadAgentDefinition'
    | 'disableSlashCommands'
    | 'thinkingConfig'
  >
  // 已经经过 filterCommandsForRemoteMode 过滤的远程安全命令集。
  remoteCommands: REPLProps['commands']
  initialMessages: MessageType[]
  remoteSessionConfig: RemoteSessionConfig
}

export async function launchRemoteSessionRepl({
  root,
  appProps,
  renderAndRun,
  config,
  remoteCommands,
  initialMessages,
  remoteSessionConfig,
}: RemoteSessionParams): Promise<void> {
  await launchRepl(
    root,
    appProps,
    {
      debug: config.debug,
      commands: remoteCommands,
      initialTools: [],
      initialMessages,
      mcpClients: [],
      autoConnectIdeFlag: config.autoConnectIdeFlag,
      mainThreadAgentDefinition: config.mainThreadAgentDefinition,
      disableSlashCommands: config.disableSlashCommands,
      remoteSessionConfig,
      thinkingConfig: config.thinkingConfig,
    },
    renderAndRun,
  )
}
