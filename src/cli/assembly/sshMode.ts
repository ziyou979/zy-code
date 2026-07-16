// SSH 模式装配。
// 对应原 root.ts 中 `feature('SSH_REMOTE') && pendingSSH?.host` 分支：
// `zy ssh <host> [dir]` 探测远程，部署二进制，生成带 unix-socket 转发的 ssh 会话。
// `--local` 跳过探测/部署，直接生成本地二进制以做代理/认证管道的 e2e 测试。

import {
  setCwdState,
  setDirectConnectServerUrl,
  setOriginalCwd,
} from 'src/bootstrap/runtime/runtimeContext.js'
import { exitWithError } from '../../cli/interactiveHelpers.js'
import { launchRepl } from '../../cli/replLauncher.js'
import type { SSHSession } from '../../ssh/createSSHSession.js'
import { gracefulShutdown } from '../../utils/gracefulShutdown.js'
import { createSystemMessage } from '../../services/messages/./constructors.js'
import type { AssemblyContext, SessionConfig } from './types.js'
// 与 cli/argvDispatch.ts:pendingSSH 同形态（仅本模块依赖到的字段）。
export type PendingSSH = {
  host: string
  cwd?: string
  // biome-ignore lint/suspicious/noExplicitAny: 与 argvDispatch 透传的 commander 选项一致
  permissionMode?: any
  dangerouslySkipPermissions?: boolean
  extraCliArgs?: string[]
  local?: boolean
}

export type SshModeParams = AssemblyContext & {
  pendingSSH: PendingSSH
  localVersion: string
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

export async function runSshMode({
  root,
  appProps,
  renderAndRun,
  pendingSSH,
  localVersion,
  config,
}: SshModeParams): Promise<void> {
  const { createSSHSession, createLocalSSHSession, SSHSessionError } = await import(
    '../../ssh/createSSHSession.js'
  )
  let sshSession: SSHSession
  try {
    if (pendingSSH.local) {
      process.stderr.write('Starting local ssh-proxy test session...\n')
      sshSession = await createLocalSSHSession({
        cwd: pendingSSH.cwd,
        permissionMode: pendingSSH.permissionMode,
        dangerouslySkipPermissions: pendingSSH.dangerouslySkipPermissions,
      })
    } else {
      process.stderr.write(`Connecting to ${pendingSSH.host}…\n`)
      // 原位进度：\r + EL0（擦除到行尾）。成功时最终 \n
      // 以便下一条消息落在新行上。当 stderr
      // 不是 TTY 时无操作（管道/重定向）—— \r 只会发出噪音。
      const isTTY = process.stderr.isTTY
      let hadProgress = false
      sshSession = await createSSHSession(
        {
          host: pendingSSH.host,
          cwd: pendingSSH.cwd,
          localVersion,
          permissionMode: pendingSSH.permissionMode,
          dangerouslySkipPermissions: pendingSSH.dangerouslySkipPermissions,
          extraCliArgs: pendingSSH.extraCliArgs,
        },
        isTTY
          ? {
              onProgress: (msg: string) => {
                hadProgress = true
                process.stderr.write(`\r  ${msg}\x1b[K`)
              },
            }
          : {},
      )
      if (hadProgress) {
        process.stderr.write('\n')
      }
    }
    setOriginalCwd(sshSession.remoteCwd)
    setCwdState(sshSession.remoteCwd)
    setDirectConnectServerUrl(pendingSSH.local ? 'local' : pendingSSH.host)
  } catch (err) {
    return await exitWithError(
      root,
      err instanceof SSHSessionError ? err.message : String(err),
      () => gracefulShutdown(1),
    )
  }
  const sshInfoMessage = createSystemMessage(
    pendingSSH.local
      ? `Local ssh-proxy test session\ncwd: ${sshSession.remoteCwd}\nAuth: unix socket → local proxy`
      : `SSH session to ${pendingSSH.host}\nRemote cwd: ${sshSession.remoteCwd}\nAuth: unix socket -R → local proxy`,
    'info',
  )
  await launchRepl(
    root,
    appProps,
    {
      debug: config.debug,
      commands: config.commands,
      initialTools: [],
      initialMessages: [sshInfoMessage],
      mcpClients: [],
      autoConnectIdeFlag: config.autoConnectIdeFlag,
      mainThreadAgentDefinition: config.mainThreadAgentDefinition,
      disableSlashCommands: config.disableSlashCommands,
      sshSession,
      thinkingConfig: config.thinkingConfig,
    },
    renderAndRun,
  )
}
