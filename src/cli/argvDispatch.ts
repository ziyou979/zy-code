import { feature } from 'bun:bundle'
import { gracefulShutdownSync } from '../utils/gracefulShutdown.js'

// ─── 跨模块共享的"挂起请求"状态：argv 改写阶段写入，run() 子命令 action 读取 ───

/** `zy cc://` 协议链接被早期 argv 解析后暂存的连接参数。 */
export type PendingConnect = {
  url: string | undefined
  authToken: string | undefined
  dangerouslySkipPermissions: boolean
}

/** `zy assistant [sessionId]` 早期解析后暂存的会话/发现意图。 */
export type PendingAssistantChat = {
  sessionId?: string
  discover: boolean
}

/** `zy ssh <host> [dir]` 早期解析后暂存的远程会话参数。 */
export type PendingSSH = {
  host: string | undefined
  cwd: string | undefined
  permissionMode: string | undefined
  dangerouslySkipPermissions: boolean
  /** --local: spawn the child CLI directly, skip ssh/probe/deploy. e2e test mode. */
  local: boolean
  /** Extra CLI args to forward to the remote CLI on initial spawn (--resume, -c). */
  extraCliArgs: string[]
}

export const pendingConnect: PendingConnect | undefined = feature('DIRECT_CONNECT')
  ? {
      url: undefined,
      authToken: undefined,
      dangerouslySkipPermissions: false,
    }
  : undefined

export const pendingAssistantChat: PendingAssistantChat | undefined = feature('KAIROS')
  ? {
      sessionId: undefined,
      discover: false,
    }
  : undefined

export const pendingSSH: PendingSSH | undefined = feature('SSH_REMOTE')
  ? {
      host: undefined,
      cwd: undefined,
      permissionMode: undefined,
      dangerouslySkipPermissions: false,
      local: false,
      extraCliArgs: [],
    }
  : undefined

// ─── argv 改写函数 ────────────────────────────────────────────────────────────

/**
 * 在 argv 中检查 cc:// 或 cc+unix:// URL —— 重写以便主命令处理它，
 * 提供完整的交互式 TUI 而不是精简的子命令。
 * 对于无头模式（-p），重写为内部的 `open` 子命令。
 */
async function rewriteArgvForCcUrl(): Promise<void> {
  if (!feature('DIRECT_CONNECT')) {
    return
  }
  const rawCliArgs = process.argv.slice(2)
  const ccIdx = rawCliArgs.findIndex((a) => a.startsWith('cc://') || a.startsWith('cc+unix://'))
  if (ccIdx === -1 || !pendingConnect) {
    return
  }

  const ccUrl = rawCliArgs[ccIdx]!
  const { parseConnectUrl } = await import('../server/parseConnectUrl.js')
  // biome-ignore lint/suspicious/noExplicitAny: parseConnectUrl 类型为内部宽松类型
  const parsed = (parseConnectUrl as any)(ccUrl)
  pendingConnect.dangerouslySkipPermissions = rawCliArgs.includes('--dangerously-skip-permissions')
  if (rawCliArgs.includes('-p') || rawCliArgs.includes('--print')) {
    // 无头模式：重写为内部 `open` 子命令
    const stripped = rawCliArgs.filter((_, i) => i !== ccIdx)
    const dspIdx = stripped.indexOf('--dangerously-skip-permissions')
    if (dspIdx !== -1) {
      stripped.splice(dspIdx, 1)
    }
    process.argv = [process.argv[0]!, process.argv[1]!, 'open', ccUrl, ...stripped]
  } else {
    // 交互模式：剥离 cc:// URL 和标志，运行主命令
    pendingConnect.url = parsed.serverUrl
    pendingConnect.authToken = parsed.authToken
    const stripped = rawCliArgs.filter((_, i) => i !== ccIdx)
    const dspIdx = stripped.indexOf('--dangerously-skip-permissions')
    if (dspIdx !== -1) {
      stripped.splice(dspIdx, 1)
    }
    process.argv = [process.argv[0]!, process.argv[1]!, ...stripped]
  }
}

/**
 * 早期处理深度链接 URI —— 由操作系统协议处理器调用。
 * 命中时直接 process.exit，不会返回。
 */
async function rewriteArgvForDeepLink(): Promise<void> {
  if (!feature('LODESTONE')) {
    return
  }

  const handleUriIdx = process.argv.indexOf('--handle-uri')
  if (handleUriIdx !== -1 && process.argv[handleUriIdx + 1]) {
    const { enableConfigs } = await import('../utils/config.js')
    enableConfigs()
    const uri = process.argv[handleUriIdx + 1]!
    const { handleDeepLinkUri } = await import('../services/deep-link/protocolHandler.js')
    const exitCode = await handleDeepLinkUri(uri)
    process.exit(exitCode)
  }

  // macOS URL 处理器：当 LaunchServices 启动我们的 .app bundle 时，
  // URL 通过 Apple Event 到达（而不是 argv）。LaunchServices 将
  // __CFBundleIdentifier 覆盖为启动 bundle 的 ID，这是一个精确的
  // 正面信号 —— 比用启发式方法导入和猜测更便宜。
  if (
    process.platform === 'darwin' &&
    process.env.__CFBundleIdentifier === 'com.zy.zy-code-url-handler'
  ) {
    const { enableConfigs } = await import('../utils/config.js')
    enableConfigs()
    const { handleUrlSchemeLaunch } = await import('../services/deep-link/protocolHandler.js')
    const urlSchemeResult = await handleUrlSchemeLaunch()
    process.exit(urlSchemeResult ?? 1)
  }
}

/**
 * `zy assistant [sessionId]` —— 暂存并剥离，以便主命令处理它，
 * 提供完整的交互式 TUI。仅限位置 0（与下方 ssh 模式匹配）——
 * indexOf 会对 `zy -p "explain assistant"` 产生误判。
 * 根标志在子命令前（例如 `--debug assistant`）会透传到存根，打印用法说明。
 */
function rewriteArgvForAssistant(): void {
  if (!(feature('KAIROS') && pendingAssistantChat)) {
    return
  }

  const rawArgs = process.argv.slice(2)
  if (rawArgs[0] !== 'assistant') {
    return
  }

  const nextArg = rawArgs[1]
  if (nextArg && !nextArg.startsWith('-')) {
    pendingAssistantChat.sessionId = nextArg
    rawArgs.splice(0, 2) // drop 'assistant' and sessionId
    process.argv = [process.argv[0]!, process.argv[1]!, ...rawArgs]
  } else if (!nextArg) {
    pendingAssistantChat.discover = true
    rawArgs.splice(0, 1) // drop 'assistant'
    process.argv = [process.argv[0]!, process.argv[1]!, ...rawArgs]
  }
  // else: `zy assistant --help` → fall through to stub
}

/**
 * `zy ssh <host> [dir]` —— 从 argv 剥离以便主命令处理器运行（完整交互式 TUI），
 * 暂存主机/目录供 REPL 分支接收。无头模式（-p）在 v1 中不受支持。
 *
 * 返回 false 表示主流程应立即中止（已触发 gracefulShutdownSync）。
 */
function rewriteArgvForSsh(): boolean {
  if (!(feature('SSH_REMOTE') && pendingSSH)) {
    return true
  }

  const rawCliArgs = process.argv.slice(2)
  // SSH 特定标志可以出现在主机位置参数之前（例如
  // `ssh --permission-mode auto host /tmp` —— 标准的 POSIX 标志在前
  // 位置参数）。在检查是否给出了主机之前将它们全部提取出来，
  // 这样 `zy ssh --permission-mode auto host` 和 `zy ssh host
  // --permission-mode auto` 是等价的。下方的主机检查只需要
  // 防御 `-h`/`--help`（commander 应该处理）。
  if (rawCliArgs[0] === 'ssh') {
    const localIdx = rawCliArgs.indexOf('--local')
    if (localIdx !== -1) {
      pendingSSH.local = true
      rawCliArgs.splice(localIdx, 1)
    }
    const dspIdx = rawCliArgs.indexOf('--dangerously-skip-permissions')
    if (dspIdx !== -1) {
      pendingSSH.dangerouslySkipPermissions = true
      rawCliArgs.splice(dspIdx, 1)
    }
    const pmIdx = rawCliArgs.indexOf('--permission-mode')
    if (pmIdx !== -1 && rawCliArgs[pmIdx + 1] && !rawCliArgs[pmIdx + 1]!.startsWith('-')) {
      pendingSSH.permissionMode = rawCliArgs[pmIdx + 1]
      rawCliArgs.splice(pmIdx, 2)
    }
    const pmEqIdx = rawCliArgs.findIndex((a) => a.startsWith('--permission-mode='))
    if (pmEqIdx !== -1) {
      pendingSSH.permissionMode = rawCliArgs[pmEqIdx]!.split('=')[1]
      rawCliArgs.splice(pmEqIdx, 1)
    }
    // 将会话恢复和模型标志转发给远程 CLI 的初始生成。
    // --continue/-c 和 --resume <uuid> 操作于远程会话历史
    // （持久化在远程的 ~/.zy/projects/<cwd>/ 下）。
    // --model 控制远程使用的模型。
    const extractFlag = (
      flag: string,
      opts: {
        hasValue?: boolean
        as?: string
      } = {},
    ) => {
      const i = rawCliArgs.indexOf(flag)
      if (i !== -1) {
        pendingSSH.extraCliArgs.push(opts.as ?? flag)
        const val = rawCliArgs[i + 1]
        if (opts.hasValue && val && !val.startsWith('-')) {
          pendingSSH.extraCliArgs.push(val)
          rawCliArgs.splice(i, 2)
        } else {
          rawCliArgs.splice(i, 1)
        }
      }
      const eqI = rawCliArgs.findIndex((a) => a.startsWith(`${flag}=`))
      if (eqI !== -1) {
        pendingSSH.extraCliArgs.push(opts.as ?? flag, rawCliArgs[eqI]!.slice(flag.length + 1))
        rawCliArgs.splice(eqI, 1)
      }
    }
    extractFlag('-c', {
      as: '--continue',
    })
    extractFlag('--continue')
    extractFlag('--resume', {
      hasValue: true,
    })
    extractFlag('--model', {
      hasValue: true,
    })
  }
  // 提取后，[1] 处剩余的任何 dash 参数要么是 -h/--help
  //（commander 处理），要么是对 ssh 未知的标志（透传给 commander
  // 以便它显示正确的错误）。只有非 dash 参数才是主机。
  if (rawCliArgs[0] === 'ssh' && rawCliArgs[1] && !rawCliArgs[1].startsWith('-')) {
    pendingSSH.host = rawCliArgs[1]
    // 可选的位置参数 cwd。
    let consumed = 2
    if (rawCliArgs[2] && !rawCliArgs[2].startsWith('-')) {
      pendingSSH.cwd = rawCliArgs[2]
      consumed = 3
    }
    const rest = rawCliArgs.slice(consumed)

    // 无头模式（-p）在 v1 中不支持 SSH —— 提前拒绝
    // 以免标志静默导致本地执行。
    if (rest.includes('-p') || rest.includes('--print')) {
      process.stderr.write('Error: headless (-p/--print) mode is not supported with zy ssh\n')
      gracefulShutdownSync(1)
      return false
    }

    // 重写 argv 以便主命令看到剩余标志但不包括 `ssh`。
    process.argv = [process.argv[0]!, process.argv[1]!, ...rest]
  }
  return true
}

/**
 * 按顺序执行所有早期 argv 改写。
 * 返回 false 表示 main() 应立即返回（SSH -p 误用时已触发 gracefulShutdownSync）。
 * LODESTONE 深链接命中会内部 process.exit，永不返回。
 */
export async function rewriteArgv(): Promise<boolean> {
  await rewriteArgvForCcUrl()
  await rewriteArgvForDeepLink()
  rewriteArgvForAssistant()
  return rewriteArgvForSsh()
}
