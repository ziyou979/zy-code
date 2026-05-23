import { feature } from 'bun:bundle'
import { access } from 'node:fs/promises'
import { tmpdir as osTmpdir } from 'node:os'
import { join as nativeJoin } from 'node:path'
import { join as posixJoin } from 'node:path/posix'
import { rearrangePipeCommand } from '../bash/bashPipeCommand.js'
import { createAndSaveSnapshot } from '../bash/ShellSnapshot.js'
import { formatShellPrefixCommand } from '../bash/shellPrefix.js'
import { quote } from '../bash/shellQuote.js'
import {
  quoteShellCommand,
  rewriteWindowsNullRedirect,
  shouldAddStdinRedirect,
} from '../bash/shellQuoting.js'
import { logForDebugging } from '../../utils/debug.js'
import { isInternalBuild } from '../../utils/envUtils.js'
import { getPlatform } from '../../utils/platform.js'
import { getSessionEnvironmentScript } from '../../utils/sessionEnvironment.js'
import { getSessionEnvVars } from '../../utils/sessionEnvVars.js'
import {
  ensureSocketInitialized,
  getZyTmuxEnv,
  hasTmuxToolBeenUsed,
} from '../../utils/tmuxSocket.js'
import { windowsPathToPosixPath } from '../../utils/windowsPaths.js'
import type { ShellProvider } from './shellProvider.js'

/**
 * 返回一个禁用扩展 glob 模式的 shell 命令，用于安全防护。
 * 扩展 glob（bash extglob、zsh EXTENDED_GLOB）可以通过
 * 恶意文件名在安全验证后展开来被利用。
 *
 * 当设置了 ZY_CODE_SHELL_PREFIX 时，实际执行的 shell 可能与
 * shellPath 不同（例如 shellPath 是 zsh 但包装器运行 bash）。在这种
 * 情况下，我们包含两种 shell 的命令。我们将 stdout 和 stderr 都
 * 重定向到 /dev/null，因为 zsh 的 command_not_found_handler 写入 STDOUT。
 *
 * 当没有设置 shell 前缀时，我们使用检测到的 shell 对应的命令。
 */
function getDisableExtglobCommand(shellPath: string): string | null {
  // 当设置了 ZY_CODE_SHELL_PREFIX 时，包装器可能使用与 shellPath 不同的
  // shell，所以我们包含 bash 和 zsh 两种命令
  if (process.env.ZY_CODE_SHELL_PREFIX) {
    // 重定向 stdout 和 stderr，因为 zsh 的 command_not_found_handler
    // 写入 stdout 而非 stderr
    return '{ shopt -u extglob || setopt NO_EXTENDED_GLOB; } >/dev/null 2>&1 || true'
  }

  // 无 shell 前缀 - 使用 shell 特定命令
  if (shellPath.includes('bash')) {
    return 'shopt -u extglob 2>/dev/null || true'
  } else if (shellPath.includes('zsh')) {
    return 'setopt NO_EXTENDED_GLOB 2>/dev/null || true'
  }
  // 未知 shell - 不做任何操作，我们不知道正确的命令
  return null
}

export async function createBashShellProvider(
  shellPath: string,
  options?: { skipSnapshot?: boolean },
): Promise<ShellProvider> {
  let currentSandboxTmpDir: string | undefined
  const snapshotPromise: Promise<string | undefined> = options?.skipSnapshot
    ? Promise.resolve(undefined)
    : createAndSaveSnapshot(shellPath).catch((error) => {
        logForDebugging(`Failed to create shell snapshot: ${error}`)
        return undefined
      })
  // 跟踪最后解析的快照路径，供 getSpawnArgs 使用
  let lastSnapshotFilePath: string | undefined

  return {
    type: 'bash',
    shellPath,
    detached: true,

    async buildExecCommand(
      command: string,
      opts: {
        id: number | string
        sandboxTmpDir?: string
        useSandbox: boolean
      },
    ): Promise<{ commandString: string; cwdFilePath: string }> {
      let snapshotFilePath = await snapshotPromise
      // 此 access() 检查不是纯 TOCTOU — 它是 getSpawnArgs 的回退决策点。
      // 当快照在会话中途消失时（tmpdir 清理），我们必须清除
      // lastSnapshotFilePath 以便 getSpawnArgs 添加 -l，使命令获得
      // login-shell 初始化。没有此检查，`source ... || true` 会静默失败，
      // 命令在没有任何 shell 初始化的情况下运行（既无快照环境也无
      // login profile）。source 上的 `|| true` 仍然防护此检查与
      // 生成的 shell 之间的竞态。
      if (snapshotFilePath) {
        try {
          await access(snapshotFilePath)
        } catch {
          logForDebugging(`Snapshot file missing, falling back to login shell: ${snapshotFilePath}`)
          snapshotFilePath = undefined
        }
      }
      lastSnapshotFilePath = snapshotFilePath

      // 将 sandboxTmpDir 暂存供 getEnvironmentOverrides 使用
      currentSandboxTmpDir = opts.sandboxTmpDir

      const tmpdir = osTmpdir()
      const isWindows = getPlatform() === 'windows'
      const shellTmpdir = isWindows ? windowsPathToPosixPath(tmpdir) : tmpdir

      // shellCwdFilePath: POSIX path used inside the bash command (pwd -P >| ...)
      // cwdFilePath: native OS path used by Node.js for readFileSync/unlinkSync
      // On non-Windows these are identical; on Windows, Git Bash needs POSIX paths
      // but Node.js needs native Windows paths for file operations.
      const shellCwdFilePath = opts.useSandbox
        ? posixJoin(opts.sandboxTmpDir!, `cwd-${opts.id}`)
        : posixJoin(shellTmpdir, `zy-${opts.id}-cwd`)
      const cwdFilePath = opts.useSandbox
        ? posixJoin(opts.sandboxTmpDir!, `cwd-${opts.id}`)
        : nativeJoin(tmpdir, `zy-${opts.id}-cwd`)

      // Defensive rewrite: the model sometimes emits Windows CMD-style `2>nul`
      // redirects. In POSIX bash (including Git Bash on Windows), this creates a
      // literal file named `nul` — a reserved device name that breaks git.
      // See anthropics/zy-code#4928.
      const normalizedCommand = rewriteWindowsNullRedirect(command)
      const addStdinRedirect = shouldAddStdinRedirect(normalizedCommand)
      let quotedCommand = quoteShellCommand(normalizedCommand, addStdinRedirect)

      // heredoc/多行命令的调试日志，用于追踪尾部处理
      // 仅在启用提交归属时记录以避免噪声
      if (feature('COMMIT_ATTRIBUTION') && (command.includes('<<') || command.includes('\n'))) {
        logForDebugging(
          `Shell: Command before quoting (first 500 chars):\n${command.slice(0, 500)}`,
        )
        logForDebugging(`Shell: Quoted command (first 500 chars):\n${quotedCommand.slice(0, 500)}`)
      }

      // Special handling for pipes: move stdin redirect after first command
      // This ensures the redirect applies to the first command, not to eval itself.
      // Without this, `eval 'rg foo | wc -l' \< /dev/null` becomes
      // `rg foo | wc -l < /dev/null` — wc reads /dev/null and outputs 0, and
      // rg (with no path arg) waits on the open spawn stdin pipe forever.
      // Applies to sandbox mode too: sandbox wraps the assembled commandString,
      // not the raw command (since PR #9189).
      if (normalizedCommand.includes('|') && addStdinRedirect) {
        quotedCommand = rearrangePipeCommand(normalizedCommand)
      }

      const commandParts: string[] = []

      // Source the snapshot file. The `|| true` guards the race between the
      // access() check above and the spawned shell's `source` — if the file
      // vanishes in that window, the `&&` chain still continues.
      if (snapshotFilePath) {
        const finalPath =
          getPlatform() === 'windows' ? windowsPathToPosixPath(snapshotFilePath) : snapshotFilePath
        commandParts.push(`source ${quote([finalPath])} 2>/dev/null || true`)
      }

      // 加载从会话启动钩子捕获的会话环境变量
      const sessionEnvScript = await getSessionEnvironmentScript()
      if (sessionEnvScript) {
        commandParts.push(sessionEnvScript)
      }

      // 为安全禁用扩展 glob 模式（在加载用户配置以覆盖之后）
      const disableExtglobCmd = getDisableExtglobCommand(shellPath)
      if (disableExtglobCmd) {
        commandParts.push(disableExtglobCmd)
      }

      // When sourcing a file with aliases, they won't be expanded in the same command line
      // because the shell parses the entire line before execution. Using eval after
      // sourcing causes a second parsing pass where aliases are now available for expansion.
      commandParts.push(`eval ${quotedCommand}`)
      // Use `pwd -P` to get the physical path of the current working directory for consistency with `process.cwd()`
      commandParts.push(`pwd -P >| ${quote([shellCwdFilePath])}`)
      let commandString = commandParts.join(' && ')

      // 如果设置了 ZY_CODE_SHELL_PREFIX 则应用
      if (process.env.ZY_CODE_SHELL_PREFIX) {
        commandString = formatShellPrefixCommand(process.env.ZY_CODE_SHELL_PREFIX, commandString)
      }

      return { commandString, cwdFilePath }
    },

    getSpawnArgs(commandString: string): string[] {
      const skipLoginShell = lastSnapshotFilePath !== undefined
      if (skipLoginShell) {
        logForDebugging('Spawning shell without login (-l flag skipped)')
      }
      return ['-c', ...(skipLoginShell ? [] : ['-l']), commandString]
    },

    async getEnvironmentOverrides(command: string): Promise<Record<string, string>> {
      // TMUX SOCKET ISOLATION (DEFERRED):
      // We initialize Zy's tmux socket ONLY AFTER the Tmux tool has been used
      // at least once, OR if the current command appears to use tmux.
      // This defers the startup cost until tmux is actually needed.
      //
      // Once the Tmux tool is used (or a tmux command runs), all subsequent Bash
      // commands will use Zy's isolated socket via the TMUX env var override.
      //
      // See tmuxSocket.ts for the full isolation architecture documentation.
      const commandUsesTmux = command.includes('tmux')
      if (isInternalBuild() && (hasTmuxToolBeenUsed() || commandUsesTmux)) {
        await ensureSocketInitialized()
      }
      const ZyTmuxEnv = getZyTmuxEnv()
      const env: Record<string, string> = {}
      // CRITICAL: Override TMUX to isolate ALL tmux commands to Zy's socket.
      // This is NOT the user's TMUX value - it points to Zy's isolated socket.
      // When null (before socket initializes), user's TMUX is preserved.
      if (ZyTmuxEnv) {
        env.TMUX = ZyTmuxEnv
      }
      if (currentSandboxTmpDir) {
        let posixTmpDir = currentSandboxTmpDir
        if (getPlatform() === 'windows') {
          posixTmpDir = windowsPathToPosixPath(posixTmpDir)
        }
        env.TMPDIR = posixTmpDir
        env.ZY_CODE_TMPDIR = posixTmpDir
        // Zsh uses TMPPREFIX (default /tmp/zsh) for heredoc temp files,
        // not TMPDIR. Set it to a path inside the sandbox tmp dir so
        // heredocs work in sandboxed zsh commands.
        // Safe to set unconditionally — non-zsh shells ignore TMPPREFIX.
        env.TMPPREFIX = posixJoin(posixTmpDir, 'zsh')
      }
      // 应用通过 /env 设置的会话环境变量（仅子进程，不含 REPL）
      for (const [key, value] of getSessionEnvVars()) {
        env[key] = value
      }
      return env
    },
  }
}
