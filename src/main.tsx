// 这些副作用必须在所有其他导入之前运行：
// 1. profileCheckpoint 在重型模块评估开始前标记入口
// 2. startMdmRawRead 触发 MDM 子进程（plutil/reg query），使其与下方
//    剩余约 135ms 的导入并行运行
// 3. startKeychainPrefetch 并行触发两个 macOS keychain 读取（OAuth + 旧版 API
//    密钥）—— 否则 isRemoteManagedSettingsEligible() 会在 applySafeConfigEnvironmentVariables()
//    内部通过同步 spawn 顺序读取它们（每次 macOS 启动约 65ms）
import { profileCheckpoint, profileReport } from './utils/startupProfiler.js'

// eslint-disable-next-line custom-rules/no-top-level-side-effects
profileCheckpoint('main_tsx_entry')

import { startMdmRawRead } from './services/settings/mdm/rawRead.js'

// eslint-disable-next-line custom-rules/no-top-level-side-effects
startMdmRawRead()

import {
  ensureKeychainPrefetchCompleted,
  startKeychainPrefetch,
} from './services/secure-storage/keychainPrefetch.js'

// eslint-disable-next-line custom-rules/no-top-level-side-effects
startKeychainPrefetch()

import { feature } from 'bun:bundle'
import { Command as CommanderCommand } from '@commander-js/extra-typings'
import {
  setClientType,
  setIsInteractive,
  setQuestionPreviewFormat,
  setSessionSource,
} from 'src/bootstrap/runtime/runtimeContext.js'
import { setInlinePlugins } from 'src/bootstrap/runtime/runtimeContext.js'
import { rewriteArgv } from './cli/argvDispatch.js'
import { resetCursor } from './cli/bootstrap/cursor.js'
import { isBeingDebugged } from './cli/bootstrap/debugCheck.js'
import { initializeEntrypoint } from './cli/bootstrap/entrypoint.js'
import { eagerLoadSettings } from './cli/bootstrap/managedSettings.js'
import { runMigrations } from './cli/bootstrap/migrations.js'
import { registerAntCommands } from './cli/commands/ant.js'
import { registerAuthCommands } from './cli/commands/auth.js'
import { registerAutomationCommands } from './cli/commands/automation.js'
import { registerMcpCommands } from './cli/commands/mcp.js'
import { registerPluginCommands } from './cli/commands/plugin.js'
import { rootAction } from './cli/commands/root.js'
import { registerUtilCommands } from './cli/commands/util.js'
import {
  applyDebugOptions,
  applyLifecycleOptions,
  applyPrintOptions,
} from './cli/options/common.js'
import { applyToolsAndMcpOptions } from './cli/options/mcpOptions.js'
import { applyModelOptions, applyThinkingAndLimitOptions } from './cli/options/modelOptions.js'
import { applyPermissionOptions } from './cli/options/permissionOptions.js'
import { applyRuntimeOptions } from './cli/options/runtimeOptions.js'
import { applySessionOptions } from './cli/options/sessionOptions.js'
import { createSortedHelpConfig } from './cli/options/sortedHelp.js'
import { init } from './entrypoints/init.js'
import { loadPolicyLimits } from './services/policy-limits/index.js'
import { loadRemoteManagedSettings } from './services/remote-managed-settings/index.js'
import { stopCapturingEarlyInput } from './utils/earlyInput.js'
import { isEnvTruthy, isInternalBuild } from './utils/envUtils.js'
import { clearPluginCache } from './services/plugins/pluginLoader.js'
import { ensureMdmSettingsLoaded } from './services/settings/mdm/settings.js'
import { initializeWarningHandler } from './utils/warningHandler.js'

// eslint-disable-next-line custom-rules/no-top-level-side-effects
profileCheckpoint('main_tsx_imports_loaded')

// 如果检测到 node 调试或检查，则退出
if (!isInternalBuild() && isBeingDebugged()) {
  // 此处直接使用 process.exit，因为我们处于导入前的顶层代码
  // 且 gracefulShutdown 尚不可用
  // eslint-disable-next-line custom-rules/no-top-level-side-effects
  process.exit(1)
}

export async function main() {
  profileCheckpoint('main_function_start')

  // 安全：防止 Windows 从当前目录执行命令
  // 必须在任何命令执行之前设置，以防止 PATH 劫持攻击
  // See: https://docs.microsoft.com/en-us/windows/win32/api/processenv/nf-processenv-searchpathw
  process.env.NoDefaultCurrentDirectoryInExePath = '1'

  // 早期初始化警告处理器以捕获警告
  initializeWarningHandler()
  process.on('exit', () => {
    resetCursor()
  })
  process.on('SIGINT', () => {
    // 在 print 模式下，print.ts 注册了自己的 SIGINT 处理器来中止
    // 进行中的查询并调用 gracefulShutdown；在此跳过以避免
    // 用同步的 process.exit() 抢占它。
    if (process.argv.includes('-p') || process.argv.includes('--print')) {
      return
    }
    process.exit(0)
  })
  profileCheckpoint('main_warning_handler_initialized')

  // 早期 argv 改写：cc:// 链接、深链接、`zy assistant`、`zy ssh`。
  // 返回 false 表示已触发 gracefulShutdownSync，主流程应立即退出。
  if (!(await rewriteArgv())) {
    return
  }

  // 早期检查 -p/--print 和 --init-only 标志以在 init() 之前设置 isInteractiveSession
  // 这是必需的，因为遥测初始化调用需要此标志的认证函数
  const cliArgs = process.argv.slice(2)
  const hasPrintFlag = cliArgs.includes('-p') || cliArgs.includes('--print')
  const hasInitOnlyFlag = cliArgs.includes('--init-only')
  const hasSdkUrl = cliArgs.some((arg) => arg.startsWith('--sdk-url'))
  const isNonInteractive = hasPrintFlag || hasInitOnlyFlag || hasSdkUrl || !process.stdout.isTTY

  // 停止为非交互模式捕获早期输入
  if (isNonInteractive) {
    stopCapturingEarlyInput()
  }

  // 设置简化的跟踪字段
  const isInteractive = !isNonInteractive
  setIsInteractive(isInteractive)

  // 根据模式初始化入口点 —— 需要在记录任何事件之前设置
  initializeEntrypoint(isNonInteractive)

  // 确定客户端类型
  const clientType = (() => {
    if (isEnvTruthy(process.env.GITHUB_ACTIONS)) {
      return 'github-action'
    }
    if (process.env.ZY_CODE_ENTRYPOINT === 'sdk-ts') {
      return 'sdk-typescript'
    }
    if (process.env.ZY_CODE_ENTRYPOINT === 'sdk-py') {
      return 'sdk-python'
    }
    if (process.env.ZY_CODE_ENTRYPOINT === 'sdk-cli') {
      return 'sdk-cli'
    }
    if (process.env.ZY_CODE_ENTRYPOINT === 'zy-vscode') {
      return 'zy-vscode'
    }
    if (process.env.ZY_CODE_ENTRYPOINT === 'local-agent') {
      return 'local-agent'
    }
    if (process.env.ZY_CODE_ENTRYPOINT === 'zy-desktop') {
      return 'zy-desktop'
    }

    // 检查是否提供了会话入口令牌（表示远程会话）
    const hasSessionIngressToken =
      process.env.ZY_CODE_SESSION_ACCESS_TOKEN || process.env.ZY_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR
    if (process.env.ZY_CODE_ENTRYPOINT === 'remote' || hasSessionIngressToken) {
      return 'remote'
    }
    return 'cli'
  })()
  setClientType(clientType)
  const previewFormat = process.env.ZY_CODE_QUESTION_PREVIEW_FORMAT
  if (previewFormat === 'markdown' || previewFormat === 'html') {
    setQuestionPreviewFormat(previewFormat)
  } else if (
    !clientType.startsWith('sdk-') &&
    // Desktop 和 CCR 通过 toolConfig 传递 previewFormat；当功能被
    // 关闭时它们传递 undefined —— 不要用 markdown 覆盖它。
    clientType !== 'zy-desktop' &&
    clientType !== 'local-agent' &&
    clientType !== 'remote'
  ) {
    setQuestionPreviewFormat('markdown')
  }

  // 标记通过 `zy remote-control` 创建的会话，以便后端识别它们
  if (process.env.ZY_CODE_ENVIRONMENT_KIND === 'bridge') {
    setSessionSource('remote-control')
  }
  profileCheckpoint('main_client_type_determined')

  // 早期解析并加载设置标志，在 init() 之前
  eagerLoadSettings()

  profileCheckpoint('main_before_run')
  await run()

  profileCheckpoint('main_after_run')
}
// biome-ignore lint/suspicious/noExplicitAny: run() 内部链式构建出
// 带 args/opts 的具体 Command<T,O>，调用方不关心具体形状，统一宽返回。
// biome-ignore lint/suspicious/noExplicitAny: 运行时动态类型处理
async function run(): Promise<CommanderCommand<any, any, any>> {
  profileCheckpoint('run_function_start')

  const program = new CommanderCommand()
    .configureHelp(createSortedHelpConfig())
    .enablePositionalOptions()
    .name('zy')
    .description(
      `ZY Code - starts an interactive session by default, use -p/--print for non-interactive output`,
    )
    .argument('[prompt]', 'Your prompt', String)
    // 子命令通过 commander 的 copyInheritedSettings 继承 helpOption ——
    // 在这里设置一次就覆盖了 mcp、plugin、auth 和所有其他子命令。
    .helpOption('-h, --help', 'Display help for command')
  profileCheckpoint('run_commander_initialized')

  // 使用 preAction 钩子在执行命令时运行初始化，
  // 而不是在显示帮助时。这避免了需要环境变量信号。
  program.hook('preAction', async (thisCommand) => {
    profileCheckpoint('preAction_start')
    // 等待在模块评估时启动的异步子进程加载（顶部 side-effect 块：startMdmRawRead、startKeychainPrefetch）。
    // 几乎免费 —— 子进程在上方约 135ms 的导入期间完成。
    // 必须在 init() 之前解析，init() 会触发第一次设置读取
    //（applySafeConfigEnvironmentVariables → getSettingsForSource('policySettings')
    // → isRemoteManagedSettingsEligible → 否则同步 keychain 读取约 65ms）。
    await Promise.all([ensureMdmSettingsLoaded(), ensureKeychainPrefetchCompleted()])
    profileCheckpoint('preAction_after_mdm')
    await init()
    profileCheckpoint('preAction_after_init')

    // Windows 上的 process.title 直接设置控制台标题；在 POSIX 上，
    // 终端 shell 集成可能会将进程名称镜像到标签页。
    // 在 init() 之后，以便 settings.json env 也可以控制此（gh-4765）。
    if (!isEnvTruthy(process.env.ZY_CODE_DISABLE_TERMINAL_TITLE)) {
      process.title = 'zy'
    }

    // 附加日志接收器以便子命令处理器可以使用 logEvent/logError。
    // PR #11106 之前 logEvent 直接分派；之后，事件排队直到
    // 接收器附加。setup() 为默认命令附加接收器，但
    // 子命令（doctor、mcp、plugin、auth）从不调用 setup()，会在
    // process.exit() 时静默丢弃事件。两个初始化都是幂等的。
    const { initSinks } = await import('./utils/sinks.js')
    initSinks()
    profileCheckpoint('preAction_after_sinks')

    // gh-33508：--plugin-dir 是顶级程序选项。默认
    // action 从自己的选项解构中读取它，但子命令
    //（plugin list、plugin install、mcp *）有自己的 action 且
    // 从不会看到它。在这里连接它以便 getInlinePlugins() 在任何地方都有效。
    // thisCommand.opts() 在这里类型为 {}，因为这个钩子附加在
    // .option('--plugin-dir', ...) 之前 —— extra-typings
    // 在添加选项时构建类型。用运行时守卫缩小范围；
    // collect 累加器 + [] 默认保证实践中为 string[]。
    const pluginDir = thisCommand.getOptionValue('pluginDir')
    if (
      Array.isArray(pluginDir) &&
      pluginDir.length > 0 &&
      pluginDir.every((p) => typeof p === 'string')
    ) {
      setInlinePlugins(pluginDir)
      clearPluginCache('preAction: --plugin-dir inline plugins')
    }
    runMigrations()
    profileCheckpoint('preAction_after_migrations')

    // 为企业客户加载远程托管设置（非阻塞）
    // 开放失败 —— 如果获取失败，继续而不使用远程设置
    // 设置到达时通过热重载应用
    // 必须在 init() 之后发生以确保允许读取配置
    void loadRemoteManagedSettings()
    void loadPolicyLimits()
    profileCheckpoint('preAction_after_remote_settings')

    // 同步加载设置（非阻塞，开放失败）
    // CLI：将本地设置上传到远程（CCR 下载由 print.ts 处理）
    if (feature('UPLOAD_USER_SETTINGS')) {
      void import('./services/settings-sync/index.js').then((m) =>
        m.uploadUserSettingsInBackground(),
      )
    }
    profileCheckpoint('preAction_after_settings_sync')
  })
  // 根命令选项按 7 组下沉到 cli/options/*。各组返回的链结果与传入的
  // program 是同一对象（commander 链式 mutate），所以忽略返回值即可。
  // 取舍：跨 helper 边界后 .action 回调里 options 类型链丢失，统一标
  // 'any' —— 既有 body 早已混用 `options.xxx` 与 `(options as { ... }).xxx`，
  // 运行时由各分支自己窄化。
  applyDebugOptions(program)
  applyLifecycleOptions(program)
  applyPrintOptions(program)
  applyPermissionOptions(program)
  applyThinkingAndLimitOptions(program)
  applyModelOptions(program)
  applyToolsAndMcpOptions(program)
  applySessionOptions(program)

  // 根 .action body 已下沉到 cli/commands/root.ts —— 函数闭包不捕获 run() 局部，
  // 直接当作 commander handler 注入即可。
  program.action(rootAction)
  program.version(`${MACRO.VERSION} (ZY Code)`, '-v, --version', 'Output the version number')

  // 运行时 / feature-gate 决定是否注册的根命令选项（worktree、advisor、teammate
  // 身份、teleport、KAIROS / BRIDGE_MODE 系等）。需要 .action 之后调用以保留原
  // 注册顺序，避免被静态选项组提前覆盖类型推断。
  applyRuntimeOptions(program)
  profileCheckpoint('run_main_options_built')

  // -p/--print 模式：跳过子命令注册。52 个子命令
  //（mcp、auth、plugin、skill、task、config、doctor、update 等）
  // 在打印模式下从不调度 —— commander 将提示路由到
  // 默认 action。子命令注册路径在基线上测量约 65ms
  // —— 主要是 isBridgeEnabled() 调用（25ms 设置 Zod 解析
  // + 40ms 同步 keychain 子进程），两者都被 try/catch 隐藏，
  // 在 enableConfigs() 之前总是返回 false。cc:// URL 在 main() 入口的 rewriteArgv()
  //（cli/argvDispatch.ts#rewriteArgvForCcUrl）中、commander.parseAsync 之前重写为
  // `open` 子命令，所以此处的 argv 检查只会命中真正"未被改写"的 cc:// 流。
  const isPrintMode = process.argv.includes('-p') || process.argv.includes('--print')
  const isCcUrl = process.argv.some((a) => a.startsWith('cc://') || a.startsWith('cc+unix://'))
  if (isPrintMode && !isCcUrl) {
    profileCheckpoint('run_before_parse')
    await program.parseAsync(process.argv)
    profileCheckpoint('run_after_parse')
    return program
  }

  // mcp / server / ssh-stub / open —— MCP 与服务相关命令组
  registerMcpCommands(program)

  // auth login / status / logout + setup-token
  registerAuthCommands(program)

  // plugin / marketplace —— 插件命令组
  registerPluginCommands(program)
  // agents / auto-mode / remote-control / assistant —— 自动化与桥接命令组
  registerAutomationCommands(program)

  // doctor / update / install / up / rollback —— 实用命令
  registerUtilCommands(program)
  // log / error / export / task / completion —— ant 内部命令组
  registerAntCommands(program)

  profileCheckpoint('run_before_parse')
  await program.parseAsync(process.argv)

  profileCheckpoint('run_after_parse')

  // 记录最终checkpoint 用于 total_time 计算
  profileCheckpoint('main_after_run')

  // 将启动性能记录到 Statsig（采样）并在启用时输出详细报告
  profileReport()
  return program
}
