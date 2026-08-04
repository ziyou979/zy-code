/* eslint-disable custom-rules/no-process-exit */

import { feature } from 'bun:bundle'
import chalk from 'chalk'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { getCwd } from 'src/services/environment/cwd.js'
import { checkForReleaseNotes } from 'src/services/release-notes/releaseNotes.js'
import { setCwd } from 'src/services/shell/shell.js'
import { initSinks } from 'src/services/telemetry/sinks.js'
import { getIsNonInteractiveSession } from 'src/bootstrap/runtime/runtimeContext.js'
import {
  getProjectRoot,
  getSessionId,
  setOriginalCwd,
  setProjectRoot,
  switchSession,
} from 'src/bootstrap/runtime/runtimeContext.js'
import { getCommands } from '../commands/index.js'
import { tSync } from '../i18n/index.js'
import { lockCurrentVersion } from '../services/native-installer/index.js'
import { initSessionMemory } from '../services/session-memory/sessionMemory.js'
import { asSessionId } from '../types/ids.js'
import { isAgentSwarmsEnabled } from '../services/swarm/agentSwarmsEnabled.js'
import { clearMemoryFileCaches } from '../services/memory/agentsMd.js'
import { checkAndRestoreTerminalBackup } from '../services/shell/appleTerminalBackup.js'
import { prefetchApiKeyFromApiKeyHelperIfSafe } from '../services/auth/auth.js'
import { getCurrentProjectConfig, getGlobalConfig } from '../services/config/config.js'
import { logForDiagnosticsNoPII } from '../services/telemetry/diagLogs.js'
import { env } from '../services/environment/env.js'
import { envDynamic } from '../services/environment/envDynamic.js'
import { isBareMode, isEnvTruthy, isInternalBuild } from '../services/infra/envUtils.js'
import { errorMessage } from '../utils/errors.js'
import { findCanonicalGitRoot, findGitRoot, getIsGit } from '../services/infra/git.js'
import { initializeFileChangedWatcher } from '../services/hooks/fileChangedWatcher.js'
import {
  captureHooksConfigSnapshot,
  updateHooksConfigSnapshot,
} from '../services/hooks/hooksConfigSnapshot.js'
import { hasWorktreeCreateHook } from '../services/hooks.js'
import { checkAndRestoreITerm2Backup } from '../services/shell/iTermBackup.js'
import { logError } from '../services/infra/log.js'
import { getRecentActivity } from '../services/branding/logoUtils.js'
import type { PermissionMode } from '../services/permissions/permissionMode.js'
import { getPlanSlug } from '../services/plans/plans.js'
import { saveWorktreeState } from '../services/sessionStorage.js'
import { profileCheckpoint } from '../services/telemetry/startupProfiler.js'
import {
  createTmuxSessionForWorktree,
  createWorktreeForSession,
  generateTmuxSessionName,
  worktreeBranchName,
} from '../services/worktree/worktree.js'

export async function setup(
  cwd: string,
  permissionMode: PermissionMode,
  allowDangerouslySkipPermissions: boolean,
  worktreeEnabled: boolean,
  worktreeName: string | undefined,
  tmuxEnabled: boolean,
  customSessionId?: string | null,
  worktreePRNumber?: number,
  messagingSocketPath?: string,
): Promise<void> {
  logForDiagnosticsNoPII('info', 'setup_started')

  // 检查 Node.js 版本是否低于 18
  const nodeVersion = process.version.match(/^v(\d+)\./)?.[1]
  if (!nodeVersion || parseInt(nodeVersion, 10) < 18) {
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.error(chalk.bold.red(tSync('setup.errorNodeVersion')))
    process.exit(1)
  }

  // 如果提供了自定义会话 ID 则设置
  if (customSessionId) {
    switchSession(asSessionId(customSessionId))
  }

  // --bare / SIMPLE：跳过 UDS 消息服务和队友快照。
  // 脚本化调用不接收注入消息，也不使用 swarm 队友。
  // 显式指定 --messaging-socket-path 是逃生通道（按 #23222 门控模式）。
  if (!isBareMode() || messagingSocketPath !== undefined) {
    // 启动 UDS 消息服务（仅 Mac/Linux）。
    // 对 ants 默认启用 — 如果未传入 --messaging-socket-path，
    // 则在 tmpdir 中创建 socket。使用 await 确保服务已绑定且
    // $ZY_CODE_MESSAGING_SOCKET 已导出，然后任何 hook
    // （特别是 SessionStart）才能派生并快照 process.env。
    if (feature('UDS_INBOX')) {
      const m = await import('../services/bridge/udsMessaging.js')
      const udsMessaging = m as unknown as {
        startUdsMessaging: (socketPath: string, options: { isExplicit: boolean }) => Promise<void>
        getDefaultUdsSocketPath: () => string
      }
      await udsMessaging.startUdsMessaging(
        messagingSocketPath ?? udsMessaging.getDefaultUdsSocketPath(),
        { isExplicit: messagingSocketPath !== undefined },
      )
    }
  }

  // 队友快照 — 仅 SIMPLE 门控（无逃生通道，bare 模式不使用 swarm）
  if (!isBareMode() && isAgentSwarmsEnabled()) {
    const { captureTeammateModeSnapshot } = await import(
      '../services/swarm/backends/teammateModeSnapshot.js'
    )
    captureTeammateModeSnapshot()
  }

  // 终端配置备份恢复 — 仅交互模式。打印模式不会
  // 修改终端设置；下次交互会话会检测并恢复中断的设置。
  if (!getIsNonInteractiveSession()) {
    // 仅在启用 swarms 时检查 iTerm2 备份
    if (isAgentSwarmsEnabled()) {
      const restoredIterm2Backup = await checkAndRestoreITerm2Backup()
      if (restoredIterm2Backup.status === 'restored') {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.log(chalk.yellow(tSync('setup.iTerm2Restored')))
      } else if (restoredIterm2Backup.status === 'failed') {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.error(
          chalk.red(
            tSync('setup.iTerm2RestoreFailed', { backupPath: restoredIterm2Backup.backupPath }),
          ),
        )
      }
    }

    // 检查并恢复 Terminal.app 备份（如果设置过程中断）
    try {
      const restoredTerminalBackup = await checkAndRestoreTerminalBackup()
      if (restoredTerminalBackup.status === 'restored') {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.log(chalk.yellow(tSync('setup.terminalRestored')))
      } else if (restoredTerminalBackup.status === 'failed') {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.error(
          chalk.red(
            tSync('setup.terminalRestoreFailed', { backupPath: restoredTerminalBackup.backupPath }),
          ),
        )
      }
    } catch (error) {
      // 记录日志但不崩溃，即使 Terminal.app 备份恢复失败
      logError(error)
    }
  }

  // 重要：setCwd() 必须在依赖 cwd 的其他代码之前调用
  setCwd(cwd)

  // 捕获 hooks 配置快照，防止隐藏的 hook 修改。
  // 重要：必须在 setCwd() 之后调用，以确保从正确的目录加载 hooks
  const hooksStart = Date.now()
  captureHooksConfigSnapshot()
  logForDiagnosticsNoPII('info', 'setup_hooks_captured', {
    duration_ms: Date.now() - hooksStart,
  })

  // 初始化 FileChanged hook 监视器 — 同步操作，读取 hook 配置快照
  initializeFileChangedWatcher(cwd)

  // 如果请求了 worktree 则处理创建
  // 重要：必须在 getCommands() 之前调用，否则 /eject 将不可用。
  if (worktreeEnabled) {
    // 与 bridgeMain.ts 对齐：配置了 hook 的会话可以在没有 git 的情况下继续，
    // 因此 createWorktreeForSession() 可以委托给 hook（非 git VCS）。
    const hasHook = hasWorktreeCreateHook()
    const inGit = await getIsGit()
    if (!hasHook && !inGit) {
      process.stderr.write(
        chalk.red(`${tSync('setup.errorWorktreeNotGitRepo', { cwd: chalk.bold(cwd) })}\n`),
      )
      process.exit(1)
    }

    const slug = worktreePRNumber ? `pr-${worktreePRNumber}` : (worktreeName ?? getPlanSlug())

    // Git 前置处理在 git 仓库中始终运行 — 即使配置了 hook —
    // 这样 --tmux 对同时有 WorktreeCreate hook 的 git 用户仍然有效。
    // 仅 hook-only（非 git）模式跳过此步骤。
    let tmuxSessionName: string | undefined
    if (inGit) {
      // 解析到主仓库根目录（处理从 worktree 内部调用的情况）。
      // findCanonicalGitRoot 是同步/仅文件系统/有缓存的；底层的
      // findGitRoot 缓存已由上方 getIsGit() 预热，所以此处几乎无开销。
      const mainRepoRoot = findCanonicalGitRoot(getCwd())
      if (!mainRepoRoot) {
        process.stderr.write(chalk.red(`${tSync('setup.errorCannotDetermineGitRoot')}\n`))
        process.exit(1)
      }

      // 如果当前在 worktree 内部，切换到主仓库以创建 worktree
      if (mainRepoRoot !== (findGitRoot(getCwd()) ?? getCwd())) {
        logForDiagnosticsNoPII('info', 'worktree_resolved_to_main_repo')
        process.chdir(mainRepoRoot)
        setCwd(mainRepoRoot)
      }

      tmuxSessionName = tmuxEnabled
        ? generateTmuxSessionName(mainRepoRoot, worktreeBranchName(slug))
        : undefined
    } else {
      // 非 git hook 模式：没有可解析的规范根目录，因此从 cwd
      // 命名 tmux 会话 — generateTmuxSessionName 只取路径的 basename。
      tmuxSessionName = tmuxEnabled
        ? generateTmuxSessionName(getCwd(), worktreeBranchName(slug))
        : undefined
    }

    let worktreeSession: Awaited<ReturnType<typeof createWorktreeForSession>>
    try {
      worktreeSession = await createWorktreeForSession(
        getSessionId(),
        slug,
        tmuxSessionName,
        worktreePRNumber ? { prNumber: worktreePRNumber } : undefined,
      )
    } catch (error) {
      process.stderr.write(
        chalk.red(`${tSync('setup.errorCreatingWorktree', { error: errorMessage(error) })}\n`),
      )
      process.exit(1)
    }

    logEvent('zy_worktree_created', { tmux_enabled: tmuxEnabled })

    // 如果启用了 tmux，为 worktree 创建 tmux 会话
    if (tmuxEnabled && tmuxSessionName) {
      const tmuxResult = await createTmuxSessionForWorktree(
        tmuxSessionName,
        worktreeSession.worktreePath,
      )
      if (tmuxResult.created) {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.log(
          chalk.green(
            tSync('setup.tmuxSessionCreated', {
              sessionName: chalk.bold(tmuxSessionName),
              attachCmd: chalk.bold(`tmux attach -t ${tmuxSessionName}`),
            }),
          ),
        )
      } else {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.error(
          chalk.yellow(
            tSync('setup.tmuxSessionCreateFailed', { error: tmuxResult.error ?? 'unknown' }),
          ),
        )
      }
    }

    process.chdir(worktreeSession.worktreePath)
    setCwd(worktreeSession.worktreePath)
    setOriginalCwd(getCwd())
    // --worktree 表示 worktree 就是会话的项目，因此 skills/hooks/
    // cron 等应在此处解析。（会话中 EnterWorktreeTool 不会
    // 修改 projectRoot — 那是一次性 worktree，项目保持稳定。）
    setProjectRoot(getCwd())
    saveWorktreeState(worktreeSession)
    // 清除内存文件缓存，因为 originalCwd 已变更
    clearMemoryFileCaches()
    // 设置缓存已在 init() 中填充（通过 applySafeConfigEnvironmentVariables），
    // 并在上方 captureHooksConfigSnapshot() 中再次填充，两次都来自原始目录的
    // .zy/settings.json。从 worktree 重新读取并重新捕获 hooks。
    updateHooksConfigSnapshot()
  }

  // 后台任务 - 仅注册首次查询前必须完成的关键任务
  logForDiagnosticsNoPII('info', 'setup_background_jobs_starting')
  // 内置 skills/plugins 在 main.tsx 中注册，先于并行的
  // getCommands() 启动 — 详见该处注释。已从 setup() 中移出，因为
  // 上方的 await 点（startUdsMessaging，约 20ms）导致 getCommands()
  // 抢先执行并缓存了空的 bundledSkills 列表。
  if (!isBareMode()) {
    initSessionMemory() // 同步操作 - 注册 hook，门控检查延迟执行
    if (feature('CONTEXT_COLLAPSE')) {
      /* eslint-disable @typescript-eslint/no-require-imports */
      ;(
        require('../services/compact/context-collapse/index.js') as typeof import('../services/compact/context-collapse/index.js')
      ).initContextCollapse()
      /* eslint-enable @typescript-eslint/no-require-imports */
    }
  }
  void lockCurrentVersion() // 锁定当前版本，防止被其他进程删除

  // 启动运行时内存监控（后台采样，不阻塞启动）
  if (typeof Bun !== 'undefined' && !getIsNonInteractiveSession()) {
    // 交互模式下每秒强制 GC 防止堆无限增长
    const gcTimer = setInterval(Bun.gc, 1000)
    gcTimer.unref()
  }
  void import('../services/diagnostics/memoryMonitor.js').then(({ initMemoryMonitor }) => {
    initMemoryMonitor()
  })
  // Windows 专用：在持续空闲且高 RSS 时驱逐可重载的驻留页。
  // 这只治理 Working Set，不代表 Private Bytes 或对象引用已经释放。
  void Promise.all([
    import('../services/diagnostics/winWorkingSetTrim.js'),
    import('../services/input/activityManager.js'),
  ]).then(([{ initWinWorkingSetTrim }, { activityManager }]) => {
    initWinWorkingSetTrim({
      isActive: () => {
        const activity = activityManager.getActivityStates()
        return activity.isCLIActive || activity.isUserActive
      },
    })
  })
  logForDiagnosticsNoPII('info', 'setup_background_jobs_launched')

  profileCheckpoint('setup_before_prefetch')
  // 预获取 Promise - 仅渲染前需要的项
  logForDiagnosticsNoPII('info', 'setup_prefetch_starting')
  // 当设置了 ZY_CODE_SYNC_PLUGIN_INSTALL 时，跳过所有插件预获取。
  // print.ts 中的同步安装路径在安装后调用 refreshPluginState()，
  // 重新加载 commands、hooks 和 agents。此处预获取会与安装竞争
  // （并发 copyPluginToVersionedCache / cachePlugin 操作同一目录），
  // 且热重载处理器在 policySettings 到达时会触发 clearPluginCache()。
  const skipPluginPrefetch =
    (getIsNonInteractiveSession() && isEnvTruthy(process.env.ZY_CODE_SYNC_PLUGIN_INSTALL)) ||
    // --bare：loadPluginHooks → loadAllPlugins 是文件系统操作，
    // 在 --bare 下 executeHooks 会提前返回，完全是浪费。
    isBareMode()
  if (!skipPluginPrefetch) {
    void getCommands(getProjectRoot())
  }
  void import('../services/plugins/loadPluginHooks.js').then((m) => {
    if (!skipPluginPrefetch) {
      void m.loadPluginHooks() // 预加载插件 hooks（由 processSessionStartHooks 在渲染前消费）
      m.setupPluginHookHotReload() // 设置插件 hooks 热重载，当设置变更时触发
    }
  })
  // --bare：跳过归因 hook 安装 + 仓库分类 + 会话文件访问分析 +
  // 团队内存监视器。这些是提交归因和使用指标的后台记账 —
  // 脚本化调用不会提交代码，而 49ms 的归因 hook stat 检查（实测）
  // 是纯粹的开销。不是提前返回：下方 --dangerously-skip-permissions
  // 安全门控、zy_started 信标和 apiKeyHelper 预获取仍需执行。
  if (!isBareMode()) {
    if (isInternalBuild()) {
      // 预热仓库分类缓存，用于 auto-undercover 模式。默认
      // undercover 开启，直到确认为内部仓库；如果解析为内部仓库，
      // 清除 prompt 缓存使下一轮获取 OFF 状态。
      void import('../services/git/commitAttribution.js').then(async (m) => {
        if (await m.isInternalModelRepo()) {
          const { clearSystemPromptSections } = await import('../constants/systemPromptSections.js')
          clearSystemPromptSections()
        }
      })
    }
    if (feature('COMMIT_ATTRIBUTION')) {
      // 动态导入以启用死代码消除（模块包含排除字符串）。
      // 延迟到下一个 tick，使 git 子进程在首次渲染后运行，
      // 而不是在 setup() 微任务窗口期间运行。
      setImmediate(() => {
        // biome-ignore lint/suspicious/noExplicitAny: 运行时动态类型处理
        void import('../services/attribution/attributionHooks.js').then((m: any) => {
          m.registerAttributionHooks() // 注册归因追踪 hooks（仅 ant 功能）
        })
      })
    }
    void import('../services/hooks/sessionFileAccessHooks.js').then((m) =>
      m.registerSessionFileAccessHooks(),
    ) // 注册会话文件访问分析 hooks
    if (feature('TEAMMEM')) {
      void import('../services/team-memory-sync/watcher.js').then((m) => m.startTeamMemoryWatcher()) // 启动团队内存同步监视器
    }
  }
  initSinks() // 附加错误日志 + 分析 sink 并排空队列中的事件

  // 会话成功率分母。在 analytics sink 附加后立即发出 —
  // 在任何可能抛出异常的解析、获取或 I/O 之前。
  // inc-3694（P0 CHANGELOG 崩溃）在下方 checkForReleaseNotes 处抛出；
  // 该点之后的所有事件均丢失。此信标是发布健康监控中
  // 最早可靠的"进程已启动"信号。
  logEvent('zy_session_started', {})

  void prefetchApiKeyFromApiKeyHelperIfSafe(getIsNonInteractiveSession()) // 预热用户级 auth.json helper 缓存
  profileCheckpoint('setup_after_prefetch')

  // 预获取 Logo v2 数据 - await 确保在 logo 渲染前就绪。
  // --bare / SIMPLE：跳过 — 发布说明是交互式 UI 显示数据，
  // 且 getRecentActivity() 会读取最多 10 个会话 JSONL 文件。
  if (!isBareMode()) {
    const { hasReleaseNotes } = await checkForReleaseNotes(getGlobalConfig().lastReleaseNotesSeen)
    if (hasReleaseNotes) {
      await getRecentActivity()
    }
  }

  // 如果权限模式设置为绕过，验证是否在安全环境中
  if (permissionMode === 'bypassPermissions' || allowDangerouslySkipPermissions) {
    // 检查是否在类 Unix 系统上以 root/sudo 运行
    // 如果在沙箱中则允许 root（例如需要 root 的 TPU devspaces）
    if (
      process.platform !== 'win32' &&
      typeof process.getuid === 'function' &&
      process.getuid() === 0 &&
      process.env.IS_SANDBOX !== '1' &&
      !isEnvTruthy(process.env.ZY_CODE_BUBBLEWRAP)
    ) {
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.error(tSync('setup.errorRootSudoNotAllowed'))
      process.exit(1)
    }

    if (
      isInternalBuild() &&
      // 跳过 Desktop 的本地代理模式 — 与 CCR/BYOC 信任模型相同
      // （受信任的 Anthropic 管理启动器有意预批准所有操作）。
      // 先例：permissionSetup.ts:861, applySettingsChange.ts:55 (PR #19116)
      process.env.ZY_CODE_ENTRYPOINT !== 'local-agent' &&
      // CCD（Desktop 中的 ZY Code）同理 — apps#29127 无条件传递该标志
      // 以解锁会话中绕过切换
      process.env.ZY_CODE_ENTRYPOINT !== 'zy-desktop'
    ) {
      // 仅在权限模式设置为绕过时才 await
      const [isDocker, hasInternet] = await Promise.all([
        envDynamic.getIsDocker(),
        env.hasInternetAccess(),
      ])
      const isBubblewrap = envDynamic.getIsBubblewrapSandbox()
      const isSandbox = process.env.IS_SANDBOX === '1'
      const isSandboxed = isDocker || isBubblewrap || isSandbox
      if (!isSandboxed || hasInternet) {
        // biome-ignore lint/suspicious/noConsole:: intentional console output
        console.error(
          tSync('setup.errorNotSandboxed', {
            isDocker: String(isDocker),
            isBubblewrap: String(isBubblewrap),
            isSandbox: String(isSandbox),
            hasInternet: String(hasInternet),
          }),
        )
        process.exit(1)
      }
    }
  }

  if (process.env.NODE_ENV === 'test') {
    return
  }

  // 记录上次会话的 zy_exit 事件？
  const projectConfig = getCurrentProjectConfig()
  if (projectConfig.lastCost !== undefined && projectConfig.lastDuration !== undefined) {
    logEvent('zy_session_exit', {
      last_session_cost: projectConfig.lastCost,
      last_session_api_duration: projectConfig.lastAPIDuration,
      last_session_tool_duration: projectConfig.lastToolDuration,
      last_session_duration: projectConfig.lastDuration,
      last_session_lines_added: projectConfig.lastLinesAdded,
      last_session_lines_removed: projectConfig.lastLinesRemoved,
      last_session_total_input_tokens: projectConfig.lastTotalInputTokens,
      last_session_total_output_tokens: projectConfig.lastTotalOutputTokens,
      last_session_total_cache_creation_input_tokens:
        projectConfig.lastTotalCacheCreationInputTokens,
      last_session_total_cache_read_input_tokens: projectConfig.lastTotalCacheReadInputTokens,
      last_session_fps_average: projectConfig.lastFpsAverage,
      last_session_fps_low_1_pct: projectConfig.lastFpsLow1Pct,
      last_session_id:
        projectConfig.lastSessionId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      ...projectConfig.lastSessionMetrics,
    })
    // 注意：我们有意在记录日志后不清除这些值。
    // 恢复会话时需要它们来还原费用数据。
    // 这些值会在下次会话退出时被覆盖。
  }
}
