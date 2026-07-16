import { feature } from 'bun:bundle'

// 修复 corepack 自动 pinning 问题，它会在用户的 package.json 中添加 yarnpkg
// eslint-disable-next-line custom-rules/no-top-level-side-effects
process.env.COREPACK_ENABLE_AUTO_PIN = '0'

// 为 CCR 环境的子进程设置最大堆大小（容器有 16GB 内存）
// eslint-disable-next-line custom-rules/no-top-level-side-effects, custom-rules/no-process-env-top-level, custom-rules/safe-env-boolean-check
if (process.env.ZY_CODE_REMOTE === 'true') {
  // eslint-disable-next-line custom-rules/no-top-level-side-effects, custom-rules/no-process-env-top-level
  const existing = process.env.NODE_OPTIONS || ''
  // eslint-disable-next-line custom-rules/no-top-level-side-effects, custom-rules/no-process-env-top-level
  process.env.NODE_OPTIONS = existing
    ? `${existing} --max-old-space-size=8192`
    : '--max-old-space-size=8192'
}

// 对照实验基线。内联在此处（而非 init.ts），因为
// BashTool/AgentTool/PowerShellTool 在导入时会将 DISABLE_BACKGROUND_TASKS 捕获到
// 模块级常量中 —— init() 执行得太晚。feature() 门控
// 会将整个块从外部构建中通过 DCE 移除。
// eslint-disable-next-line custom-rules/no-top-level-side-effects, custom-rules/no-process-env-top-level
if (feature('ABLATION_BASELINE') && process.env.ZY_CODE_ABLATION_BASELINE) {
  for (const k of [
    'ZY_CODE_SIMPLE',
    'ZY_CODE_DISABLE_THINKING',
    'DISABLE_COMPACT',
    'DISABLE_AUTO_COMPACT',
    'ZY_CODE_DISABLE_AUTO_MEMORY',
    'ZY_CODE_DISABLE_BACKGROUND_TASKS',
  ]) {
    // eslint-disable-next-line custom-rules/no-top-level-side-effects, custom-rules/no-process-env-top-level
    process.env[k] ??= '1'
  }
}

/**
 * 引导入口 —— 在加载完整 CLI 之前检查特殊标志。
 * 所有导入都是动态的，以最小化快速路径的模块求值。
 * --version 的快速路径在此文件之外零导入。
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2)

  // --version/-v 快速路径：无需加载任何模块
  if (args.length === 1 && (args[0] === '--version' || args[0] === '-v' || args[0] === '-V')) {
    // MACRO.VERSION 在构建时内联
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.log(`${MACRO.VERSION} (ZY Code)`)
    return
  }

  // 其他路径：加载启动性能分析器
  const { profileCheckpoint } = await import('../utils/startupProfiler.js')
  profileCheckpoint('cli_entry')

  // --dump-system-prompt 快速路径：输出渲染后的系统提示并退出。
  // 用于提示词敏感度评估，以提取特定提交的系统提示。
  // 仅限 Ant 内部使用：通过 feature flag 从外部构建中移除。
  if (feature('DUMP_SYSTEM_PROMPT') && args[0] === '--dump-system-prompt') {
    profileCheckpoint('cli_dump_system_prompt_path')
    const { enableConfigs } = await import('../services/config/config.js')
    enableConfigs()
    const { getMainLoopModel } = await import('../services/model/model.js')
    const modelIdx = args.indexOf('--model')
    const model = (modelIdx !== -1 && args[modelIdx + 1]) || getMainLoopModel()
    const { getSystemPrompt, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } = await import(
      '../constants/prompts.js'
    )
    const prompt = await getSystemPrompt([], model!)

    // --exclude-dynamic-system-prompt-sections: 仅输出静态区（boundary 之前），
    // 改进跨用户 prompt 缓存对比。
    const excludeDynamic = args.includes('--exclude-dynamic-system-prompt-sections')
    if (excludeDynamic) {
      const boundaryIdx = prompt.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
      const staticSections = boundaryIdx !== -1 ? prompt.slice(0, boundaryIdx) : prompt
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.log(staticSections.filter(Boolean).join('\n'))
    } else {
      // biome-ignore lint/suspicious/noConsole:: intentional console output
      console.log(prompt.join('\n'))
    }
    return
  }
  if (process.argv[2] === '--claude-in-chrome-mcp') {
    profileCheckpoint('cli_Zy_in_chrome_mcp_path')
    const { runClaudeInChromeMcpServer } = await import('../services/claude-in-chrome/mcpServer.js')
    await runClaudeInChromeMcpServer()
    return
  } else if (process.argv[2] === '--chrome-native-host') {
    profileCheckpoint('cli_chrome_native_host_path')
    const { runChromeNativeHost } = await import('../services/claude-in-chrome/chromeNativeHost.js')
    await runChromeNativeHost()
    return
  } else if (feature('CHICAGO_MCP') && process.argv[2] === '--computer-use-mcp') {
    profileCheckpoint('cli_computer_use_mcp_path')
    const { runComputerUseMcpServer } = await import('../services/computer-use/mcpServer.js')
    await runComputerUseMcpServer()
    return
  }

  // `--daemon-worker=<kind>` 快速路径（内部 —— supervisor 派生此进程）。
  // 必须放在 daemon 子命令检查之前：每个 worker 单独派生，因此
  // 对性能敏感。此层不启用 enableConfigs()，无分析 sink ——
  // worker 是轻量级的。如果某种 worker 需要配置/认证（如 assistant），
  // 它会在自己的 run() 函数中调用。
  if (feature('DAEMON') && args[0] === '--daemon-worker') {
    const workerRegistry = (await import('../daemon/workerRegistry.js')) as unknown as {
      runDaemonWorker: (kind: string) => Promise<void>
    }
    await workerRegistry.runDaemonWorker(args[1])
    return
  }

  // `zy remote-control` 快速路径（也接受旧版 `zy remote` / `zy sync` / `zy bridge`）：
  // 将本地机器作为 bridge 环境提供服务。
  // feature() 必须保持内联以实现构建时死代码消除；
  // isBridgeEnabled() 检查运行时 GrowthBook 门控。
  if (
    feature('BRIDGE_MODE') &&
    (args[0] === 'remote-control' ||
      args[0] === 'rc' ||
      args[0] === 'remote' ||
      args[0] === 'sync' ||
      args[0] === 'bridge')
  ) {
    profileCheckpoint('cli_bridge_path')
    const { enableConfigs } = await import('../services/config/config.js')
    enableConfigs()
    const { getWireDisabledReason, checkWireMinVersion } = await import(
      '../bridge/bridgeEnabled.js'
    )
    const { BRIDGE_LOGIN_ERROR } = await import('../bridge/types.js')
    const { bridgeMain } = await import('../bridge/bridgeMain.js')
    const { exitWithError } = await import('../services/shell/process.js')

    // 认证检查必须放在 GrowthBook 门控检查之前 —— 没有认证，
    // GrowthBook 没有用户上下文，会返回过期/默认的 false。
    // getWireDisabledReason 会等待 GB 初始化，因此返回值是最新的
    //（而非过期的磁盘缓存），但 init 仍需要认证头才能工作。
    const { getZyAIOAuthTokens } = await import('../services/auth/auth.js')
    if (!getZyAIOAuthTokens()?.accessToken) {
      exitWithError(BRIDGE_LOGIN_ERROR)
    }
    const disabledReason = await getWireDisabledReason()
    if (disabledReason) {
      exitWithError(`Error: ${disabledReason}`)
    }
    const versionError = checkWireMinVersion()
    if (versionError) {
      exitWithError(versionError)
    }

    // Bridge 是一个远程控制功能 —— 检查策略限制
    const { waitForPolicyLimitsToLoad, isPolicyAllowed } = await import(
      '../services/policy-limits/index.js'
    )
    await waitForPolicyLimitsToLoad()
    if (!isPolicyAllowed('allow_remote_control')) {
      exitWithError("Error: Remote Control is disabled by your organization's policy.")
    }
    await bridgeMain(args.slice(1))
    return
  }

  // `zy daemon [subcommand]` 快速路径：长期运行的 supervisor。
  if (feature('DAEMON') && args[0] === 'daemon') {
    profileCheckpoint('cli_daemon_path')
    const { enableConfigs } = await import('../services/config/config.js')
    enableConfigs()
    const { initSinks } = await import('../utils/sinks.js')
    initSinks()
    const daemonModule = (await import('../daemon/main.js')) as unknown as {
      daemonMain: (args: string[]) => Promise<void>
    }
    await daemonModule.daemonMain(args.slice(1))
    return
  }

  // `zy ps|logs|attach|kill` 和 `--bg`/`--background` 快速路径。
  // 针对 ~/.zy/sessions/ 注册表的会话管理。标志
  // 字面量是内联的，因此 bg.js 仅在实际分发时加载。
  if (
    feature('BG_SESSIONS') &&
    (args[0] === 'ps' ||
      args[0] === 'logs' ||
      args[0] === 'attach' ||
      args[0] === 'kill' ||
      args.includes('--bg') ||
      args.includes('--background'))
  ) {
    profileCheckpoint('cli_bg_path')
    const { enableConfigs } = await import('../services/config/config.js')
    enableConfigs()
    const bg = (await import('../cli/bg.js')) as unknown as {
      psHandler: (args: string[]) => Promise<void>
      logsHandler: (id: string) => Promise<void>
      attachHandler: (id: string) => Promise<void>
      killHandler: (id: string) => Promise<void>
      handleBgFlag: (args: string[]) => Promise<void>
    }
    switch (args[0]) {
      case 'ps':
        await bg.psHandler(args.slice(1))
        break
      case 'logs':
        await bg.logsHandler(args[1])
        break
      case 'attach':
        await bg.attachHandler(args[1])
        break
      case 'kill':
        await bg.killHandler(args[1])
        break
      default:
        await bg.handleBgFlag(args)
    }
    return
  }

  // 模板 job 命令快速路径。
  if (feature('TEMPLATES') && (args[0] === 'new' || args[0] === 'list' || args[0] === 'reply')) {
    profileCheckpoint('cli_templates_path')
    const { templatesMain } = (await import('../cli/handlers/templateJobs.js')) as unknown as {
      templatesMain: (args: string[]) => Promise<void>
    }
    await templatesMain(args)
    // process.exit（非 return）—— mountFleetView 的 Ink TUI 可能留下事件
    // 循环句柄阻止自然退出。
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(0)
  }

  // `zy environment-runner` 快速路径：无头 BYOC 运行器。
  // feature() 必须保持内联以实现构建时死代码消除。
  if (feature('BYOC_ENVIRONMENT_RUNNER') && args[0] === 'environment-runner') {
    profileCheckpoint('cli_environment_runner_path')
    const { environmentRunnerMain } = (await import(
      '../environment-runner/main.js'
    )) as unknown as {
      environmentRunnerMain: (args: string[]) => Promise<void>
    }
    await environmentRunnerMain(args.slice(1))
    return
  }

  // `zy self-hosted-runner` 快速路径：无头自托管运行器，
  // 面向 SelfHostedRunnerWorkerService API（注册 + 轮询；轮询即为心跳）。
  // feature() 必须保持内联以实现构建时死代码消除。
  if (feature('SELF_HOSTED_RUNNER') && args[0] === 'self-hosted-runner') {
    profileCheckpoint('cli_self_hosted_runner_path')
    const { selfHostedRunnerMain } = (await import('../self-hosted-runner/main.js')) as unknown as {
      selfHostedRunnerMain: (args: string[]) => Promise<void>
    }
    await selfHostedRunnerMain(args.slice(1))
    return
  }

  // --worktree --tmux 快速路径：在加载完整 CLI 之前 exec 进入 tmux
  const hasTmuxFlag = args.includes('--tmux') || args.includes('--tmux=classic')
  if (
    hasTmuxFlag &&
    (args.includes('-w') ||
      args.includes('--worktree') ||
      args.some((a) => a.startsWith('--worktree=')))
  ) {
    profileCheckpoint('cli_tmux_worktree_fast_path')
    const { enableConfigs } = await import('../services/config/config.js')
    enableConfigs()
    const { isWorktreeModeEnabled } = await import('../utils/worktreeModeEnabled.js')
    if (isWorktreeModeEnabled()) {
      const { execIntoTmuxWorktree } = await import('../services/worktree/worktree.js')
      const result = await execIntoTmuxWorktree(args)
      if (result.handled) {
        return
      }
      // 如果未处理（如发生错误），回退到正常 CLI 流程
      if (result.error) {
        const { exitWithError } = await import('../services/shell/process.js')
        exitWithError(result.error)
      }
    }
  }

  // 将常见的更新标志错误重定向到 update 子命令
  if (args.length === 1 && (args[0] === '--update' || args[0] === '--upgrade')) {
    process.argv = [process.argv[0]!, process.argv[1]!, 'update']
  }

  // --bare：尽早设置 SIMPLE，使门控在模块求值 / commander
  // 选项构建时触发（而非仅在 action handler 内部）。
  if (args.includes('--bare')) {
    process.env.ZY_CODE_SIMPLE = '1'
  }

  // 未检测到特殊标志，加载并运行完整 CLI
  const { startCapturingEarlyInput } = await import('../utils/earlyInput.js')
  startCapturingEarlyInput()
  profileCheckpoint('cli_before_main_import')
  const { main: cliMain } = await import('../main.js')
  profileCheckpoint('cli_after_main_import')
  await cliMain()
  profileCheckpoint('cli_after_main_complete')
}

// eslint-disable-next-line custom-rules/no-top-level-side-effects
void main()
