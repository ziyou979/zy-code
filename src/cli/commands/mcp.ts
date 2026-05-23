import { feature } from 'bun:bundle'
import type { Command } from '@commander-js/extra-typings'
import {
  getOriginalCwd,
  setCwdState,
  setDirectConnectServerUrl,
  setOriginalCwd,
} from '../../bootstrap/state.js'
import { registerMcpAddCommand } from '../../commands/mcp/addCommand.js'
import { registerMcpXaaIdpCommand } from '../../commands/mcp/xaaIdpCommand.js'
import {
  createDirectConnectSession,
  DirectConnectError,
} from '../../server/createDirectConnectSession.js'
import { isXaaEnabled } from '../../services/mcp/xaaIdpLogin.js'
import { pendingConnect } from '../argvDispatch.js'
import { createSortedHelpConfig } from '../options/sortedHelp.js'

/**
 * 注册 MCP 相关命令组：
 * - zy mcp <serve | remove | list | get | add-json | add-from-zy-desktop | reset-project-choices>
 * - zy mcp add（注册到 mcp 子命令上，由 registerMcpAddCommand 单独管理）
 * - zy mcp xaa-idp（feature isXaaEnabled）
 * - zy server（DIRECT_CONNECT）
 * - zy ssh <host> [dir]（SSH_REMOTE，stub —— 真实流程由 main 内 argv 改写）
 * - zy open <cc-url>（DIRECT_CONNECT，仅 -p 无头模式）
 */
// biome-ignore lint/suspicious/noExplicitAny: program 类型链跨函数边界不可保留
export function registerMcpCommands(program: Command<any, any, any>): void {
  const mcp = program
    .command('mcp')
    .description('Configure and manage MCP servers')
    .configureHelp(createSortedHelpConfig())
    .enablePositionalOptions()
  mcp
    .command('serve')
    .description(`Start the ZY Code MCP server`)
    .option('-d, --debug', 'Enable debug mode', () => true)
    .option('--verbose', 'Override verbose mode setting from config', () => true)
    .action(async ({ debug, verbose }: { debug?: boolean; verbose?: boolean }) => {
      const { mcpServeHandler } = await import('../handlers/mcp.js')
      await mcpServeHandler({
        debug,
        verbose,
      })
    })

  // 注册 mcp add 子命令（为可测试性提取）
  registerMcpAddCommand(mcp)
  if (isXaaEnabled()) {
    registerMcpXaaIdpCommand(mcp)
  }
  mcp
    .command('remove <name>')
    .description('Remove an MCP server')
    .option(
      '-s, --scope <scope>',
      'Configuration scope (local, user, or project) - if not specified, removes from whichever scope it exists in',
    )
    .action(
      async (
        name: string,
        options: {
          scope?: string
        },
      ) => {
        const { mcpRemoveHandler } = await import('../handlers/mcp.js')
        await mcpRemoveHandler(name, options)
      },
    )
  mcp
    .command('list')
    .description(
      'List configured MCP servers. Note: The workspace trust dialog is skipped and stdio servers from .mcp.json are spawned for health checks. Only use this command in directories you trust.',
    )
    .action(async () => {
      const { mcpListHandler } = await import('../handlers/mcp.js')
      await mcpListHandler()
    })
  mcp
    .command('get <name>')
    .description(
      'Get details about an MCP server. Note: The workspace trust dialog is skipped and stdio servers from .mcp.json are spawned for health checks. Only use this command in directories you trust.',
    )
    .action(async (name: string) => {
      const { mcpGetHandler } = await import('../handlers/mcp.js')
      await mcpGetHandler(name)
    })
  mcp
    .command('add-json <name> <json>')
    .description('Add an MCP server (stdio or SSE) with a JSON string')
    .option('-s, --scope <scope>', 'Configuration scope (local, user, or project)', 'local')
    .option('--client-secret', 'Prompt for OAuth client secret (or set MCP_CLIENT_SECRET env var)')
    .action(
      async (
        name: string,
        json: string,
        options: {
          scope?: string
          clientSecret?: true
        },
      ) => {
        const { mcpAddJsonHandler } = await import('../handlers/mcp.js')
        await mcpAddJsonHandler(name, json, options)
      },
    )
  mcp
    .command('add-from-zy-desktop')
    .description('Import MCP servers from Zy Desktop (Mac and WSL only)')
    .option('-s, --scope <scope>', 'Configuration scope (local, user, or project)', 'local')
    .action(async (options: { scope?: string }) => {
      const { mcpAddFromDesktopHandler } = await import('../handlers/mcp.js')
      await mcpAddFromDesktopHandler(options)
    })
  mcp
    .command('reset-project-choices')
    .description(
      'Reset all approved and rejected project-scoped (.mcp.json) servers within this project',
    )
    .action(async () => {
      const { mcpResetChoicesHandler } = await import('../handlers/mcp.js')
      await mcpResetChoicesHandler()
    })

  // zy server
  if (feature('DIRECT_CONNECT')) {
    program
      .command('server')
      .description('Start a ZY Code session server')
      .option('--port <number>', 'HTTP port', '0')
      .option('--host <string>', 'Bind address', '0.0.0.0')
      .option('--auth-token <token>', 'Bearer token for auth')
      .option('--unix <path>', 'Listen on a unix domain socket')
      .option('--workspace <dir>', 'Default working directory for sessions that do not specify cwd')
      .option(
        '--idle-timeout <ms>',
        'Idle timeout for detached sessions in ms (0 = never expire)',
        '600000',
      )
      .option('--max-sessions <n>', 'Maximum concurrent sessions (0 = unlimited)', '32')
      .action(
        async (opts: {
          port: string
          host: string
          authToken?: string
          unix?: string
          workspace?: string
          idleTimeout: string
          maxSessions: string
        }) => {
          const { randomBytes } = await import('node:crypto')
          const { startServer } = await import('../../server/server.js')
          const { SessionManager } = await import('../../server/sessionManager.js')
          const { DangerousBackend } = await import('../../server/backends/dangerousBackend.js')
          const { printBanner } = await import('../../server/serverBanner.js')
          const { createServerLogger } = await import('../../server/serverLog.js')
          const { writeServerLock, removeServerLock, probeRunningServer } = await import(
            '../../server/lockfile.js'
          )
          const existing = await probeRunningServer()
          if (existing) {
            process.stderr.write(
              `A ZY server is already running (pid ${existing.pid}) at ${existing.httpUrl}\n`,
            )
            process.exit(1)
          }
          const authToken = opts.authToken ?? `sk-ant-cc-${randomBytes(16).toString('base64url')}`
          const config = {
            port: parseInt(opts.port, 10),
            host: opts.host,
            authToken,
            unix: opts.unix,
            workspace: opts.workspace,
            idleTimeoutMs: parseInt(opts.idleTimeout, 10),
            maxSessions: parseInt(opts.maxSessions, 10),
          }
          const backend = new DangerousBackend()
          const sessionManager = new SessionManager(backend, {
            idleTimeoutMs: config.idleTimeoutMs,
            maxSessions: config.maxSessions,
          })
          const logger = createServerLogger()
          const server = startServer(config, sessionManager, logger)
          const actualPort = server.port ?? config.port
          printBanner(config, authToken, actualPort)
          await writeServerLock({
            pid: process.pid,
            port: actualPort,
            host: config.host,
            httpUrl: config.unix ? `unix:${config.unix}` : `http://${config.host}:${actualPort}`,
            startedAt: Date.now(),
          })
          let shuttingDown = false
          const shutdown = async () => {
            if (shuttingDown) {
              return
            }
            shuttingDown = true
            // 在拆除会话之前停止接受新连接。
            server.stop(true)
            await sessionManager.destroyAll()
            await removeServerLock()
            process.exit(0)
          }
          process.once('SIGINT', () => void shutdown())
          process.once('SIGTERM', () => void shutdown())
        },
      )
  }

  // `zy ssh <host> [dir]` —— 仅在此处注册以便 --help 显示它。
  // 实际的交互流程由 main() 中的早期 argv 重写处理
  //（与上方的 DIRECT_CONNECT/cc:// 模式并行）。如果 commander 到达
  // 此 action 意味着 argv 重写没有触发（例如用户运行
  // `zy ssh` 没有主机）—— 只打印用法。
  if (feature('SSH_REMOTE')) {
    program
      .command('ssh <host> [dir]')
      .description(
        'Run ZY Code on a remote host over SSH. Deploys the binary and ' +
          'tunnels API auth back through your local machine — no remote setup needed.',
      )
      .option('--permission-mode <mode>', 'Permission mode for the remote session')
      .option(
        '--dangerously-skip-permissions',
        'Skip all permission prompts on the remote (dangerous)',
      )
      .option(
        '--local',
        'e2e test mode — spawn the child CLI locally (skip ssh/deploy). ' +
          'Exercises the auth proxy and unix-socket plumbing without a remote host.',
      )
      .action(async () => {
        // main() 中的 argv 重写应该在 commander 运行之前消费 `ssh <host>`。
        // 到达这里意味着主机缺失或
        // 重写谓词不匹配。
        process.stderr.write(
          'Usage: zy ssh <user@host | ssh-config-alias> [dir]\n\n' +
            "Runs ZY Code on a remote Linux host. You don't need to install\n" +
            'anything on the remote or run `zy auth login` there — the binary is\n' +
            'deployed over SSH and API auth tunnels back through your local machine.\n',
        )
        process.exit(1)
      })
  }

  // zy connect —— 子命令仅处理 -p（无头）模式。
  // 交互模式（不带 -p）由 main() 中的早期 argv 重写处理
  // 重定向到主命令，具有完整 TUI 支持。
  if (feature('DIRECT_CONNECT')) {
    program
      .command('open <cc-url>')
      .description('Connect to a ZY Code server (internal — use cc:// URLs)')
      .option('-p, --print [prompt]', 'Print mode (headless)')
      .option('--output-format <format>', 'Output format: text, json, stream-json', 'text')
      .action(
        async (
          ccUrl: string,
          opts: {
            print?: string | boolean
            outputFormat?: string
          },
        ) => {
          const { parseConnectUrl } = await import('../../server/parseConnectUrl.js')
          // biome-ignore lint/suspicious/noExplicitAny: parseConnectUrl 类型为内部宽松类型
          const { serverUrl, authToken } = (parseConnectUrl as any)(ccUrl)
          let connectConfig
          try {
            const session = await createDirectConnectSession({
              serverUrl,
              authToken,
              cwd: getOriginalCwd(),
              dangerouslySkipPermissions: pendingConnect?.dangerouslySkipPermissions,
            })
            if (session.workDir) {
              setOriginalCwd(session.workDir)
              setCwdState(session.workDir)
            }
            setDirectConnectServerUrl(serverUrl)
            connectConfig = session.config
          } catch (err) {
            // biome-ignore lint/suspicious/noConsole: intentional error output
            console.error(err instanceof DirectConnectError ? err.message : String(err))
            process.exit(1)
          }
          const { runConnectHeadless } = await import('../../server/connectHeadless.js')
          const prompt = typeof opts.print === 'string' ? opts.print : ''
          const interactive = opts.print === true
          await runConnectHeadless(connectConfig, prompt, opts.outputFormat, interactive)
        },
      )
  }
}
