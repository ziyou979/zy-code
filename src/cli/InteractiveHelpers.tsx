import { feature } from 'bun:bundle'
import { appendFileSync } from 'node:fs'
import React from 'react'
import { logEvent } from 'src/services/analytics/index.js'
import {
  getExternalAgentsMdIncludes,
  getMemoryFiles,
  shouldShowAgentsMdExternalIncludesWarning,
} from 'src/services/memory/agentsMd.js'
import { gracefulShutdown, gracefulShutdownSync } from 'src/bootstrap/lifecycle/gracefulShutdown.js'
import type { ChannelEntry } from 'src/bootstrap/runtime/runtimeContext.js'
import {
  getAllowedChannels,
  setAllowedChannels,
  setHasDevChannels,
} from 'src/bootstrap/runtime/runtimeContext.js'
import { setSessionTrustAccepted } from 'src/bootstrap/runtime/runtimeContext.js'
import { setStatsStore } from 'src/bootstrap/runtime/runtimeContext.js'
import { startDeferredPrefetches } from '../cli/bootstrap/prefetch.js'
import type { Command } from '../commands/index.js'
import { createStatsStore, type StatsStore } from '../context/stats.js'
import { getSystemContext } from '../services/context/context.js'
import { initializeTelemetryAfterTrust } from '../entrypoints/init.js'
import { isSynchronizedOutputSupported } from '../ink/terminal.js'
import type { RenderOptions, Root, TextProps } from '../ink/index.js'
import { KeybindingSetup } from '../keybindings/KeybindingProviderSetup.js'
import {
  checkGate_CACHED_OR_BLOCKING,
  initializeGrowthBook,
  resetGrowthBook,
} from '../services/analytics/growthbook.js'
import { updateDeepLinkTerminalPreference } from '../services/deep-link/terminalPreference.js'
import { handleMcpjsonServerApprovals } from '../components/mcp/MCPServerApprovalController.js'
import { getDefaultStandardModel } from '../services/model/model.js'
import { AppStateProvider } from '../state/AppState.js'
import { onChangeAppState } from '../state/onChangeAppState.js'
import { normalizeApiKeyForConfig } from '../services/auth/authPortable.js'
import {
  checkHasTrustDialogAccepted,
  getApiKeyStatus,
  getGlobalConfig,
  saveGlobalConfig,
} from '../services/config/config.js'
import { isEnvTruthy, isRunningOnHomespace, isTestEnv } from '../services/infra/envUtils.js'
import { type FpsMetrics, FpsTracker } from '../utils/fpsTracker.js'
import { updateGithubRepoPathMapping } from '../services/github/githubRepoPathMapping.js'
import { applyConfigEnvironmentVariables } from '../services/environment/managedEnv.js'
import type { PermissionMode } from '../services/permissions/permissionMode.js'
import { getBaseRenderOptions } from '../terminal-ui/renderOptions.js'
import { getSettingsWithAllErrors } from '../services/settings/allErrors.js'
import {
  hasAutoModeOptIn,
  hasSkipDangerousModePermissionPrompt,
} from '../services/settings/settings.js'
export function completeOnboarding(): void {
  saveGlobalConfig((current) => ({
    ...current,
    hasCompletedOnboarding: true,
    lastOnboardingVersion: MACRO.VERSION,
  }))
}
export function showDialog<T = void>(
  root: Root,
  renderer: (done: (result: T) => void) => React.ReactNode,
): Promise<T> {
  return new Promise<T>((resolve) => {
    const done = (result: T): void => void resolve(result)
    root.render(renderer(done))
  })
}

/**
 * 通过 Ink 渲染错误消息，然后卸载并退出。
 * Ink 根节点创建后的致命错误应使用此方法；Ink 的 patchConsole 会吞掉
 * console.error，因此改为通过 React 树渲染。
 */
export async function exitWithError(
  root: Root,
  message: string,
  beforeExit?: () => Promise<void>,
): Promise<never> {
  return exitWithMessage(root, message, {
    color: 'error',
    beforeExit,
  })
}

/**
 * 通过 Ink 渲染消息，然后卸载并退出。
 * Ink 根节点创建后的消息应使用此方法；Ink 的 patchConsole 会吞掉
 * console 输出，因此改为通过 React 树渲染。
 */
export async function exitWithMessage(
  root: Root,
  message: string,
  options?: {
    color?: TextProps['color']
    exitCode?: number
    beforeExit?: () => Promise<void>
  },
): Promise<never> {
  const { Text } = await import('../ink/index.js')
  const color = options?.color
  const exitCode = options?.exitCode ?? 1
  root.render(color ? <Text color={color}>{message}</Text> : <Text>{message}</Text>)
  root.unmount()
  await options?.beforeExit?.()
  // eslint-disable-next-line custom-rules/no-process-exit -- exit after Ink unmount
  process.exit(exitCode)
}

/**
 * 显示由 AppStateProvider + KeybindingSetup 包裹的设置对话框。
 * showSetupScreens() 中每个对话框都需要这些包装器，此函数用于减少重复代码。
 */
export function showSetupDialog<T = void>(
  root: Root,
  renderer: (done: (result: T) => void) => React.ReactNode,
  options?: {
    onChangeAppState?: typeof onChangeAppState
  },
): Promise<T> {
  return showDialog<T>(root, (done) => (
    <AppStateProvider onChangeAppState={options?.onChangeAppState}>
      <KeybindingSetup>{renderer(done)}</KeybindingSetup>
    </AppStateProvider>
  ))
}

/**
 * 将主界面渲染到根节点并等待退出。
 * 统一处理收尾流程：启动延迟预取、等待退出并优雅关闭。
 */
export async function renderAndRun(root: Root, element: React.ReactNode): Promise<void> {
  root.render(element)
  startDeferredPrefetches()
  await root.waitUntilExit()
  await gracefulShutdown(0)
}
export async function showSetupScreens(
  root: Root,
  permissionMode: PermissionMode,
  allowDangerouslySkipPermissions: boolean,
  commands?: Command[],
  ClaudeInChrome?: boolean,
  devChannels?: ChannelEntry[],
): Promise<boolean> {
  if (
    isTestEnv() ||
    isEnvTruthy(false) ||
    process.env.IS_DEMO // Skip onboarding in demo mode
  ) {
    return false
  }
  const config = getGlobalConfig()
  let onboardingShown = false
  if (
    !config.theme ||
    !config.hasCompletedOnboarding || // always show onboarding at least once
    !getDefaultStandardModel() // standard 模型未配置时强制进入配置
  ) {
    onboardingShown = true
    const { Onboarding } = await import('../components/Onboarding.js')
    await showSetupDialog(
      root,
      (done) => (
        <Onboarding
          onDone={() => {
            completeOnboarding()
            void done()
          }}
        />
      ),
      {
        onChangeAppState,
      },
    )
  }

  // 交互式会话无论处于哪种权限模式都显示信任对话框。
  // 该对话框是工作区的信任边界：会警告不受信任的仓库，并检查 AGENTS.md 的外部 include。
  // bypassPermissions 模式只影响工具执行权限，不影响工作区信任。
  // 非交互式会话（CI/CD 使用 -p）不会进入 showSetupScreens。
  // claubbit 中跳过权限检查。
  if (!isEnvTruthy(process.env.CLAUBBIT)) {
    // 快速路径：CWD 已受信任时跳过 TrustDialog 的导入与渲染。
    // 若此处返回 true，无论安全功能如何，TrustDialog 都会自动完成，
    // 因此可省去动态导入和渲染周期。
    if (!checkHasTrustDialogAccepted()) {
      const { TrustDialog } = await import('../components/TrustDialog/TrustDialog.js')
      await showSetupDialog(root, (done) => <TrustDialog commands={commands} onDone={done} />)
    }

    // 标记本会话已验证信任；GrowthBook 据此决定是否附带认证请求头。
    setSessionTrustAccepted(true)

    // 建立信任后重置并重新初始化 GrowthBook。
    // 这可防御登录/登出造成的陈旧状态：清除旧客户端，使下次初始化采用最新认证请求头。
    resetGrowthBook()
    void initializeGrowthBook()

    // 信任已建立，若尚未预取则预取系统上下文。
    void getSystemContext()

    // 设置有效时，检查 mcp.json 中是否有需要审批的服务器。
    const { errors: allErrors } = getSettingsWithAllErrors()
    if (allErrors.length === 0) {
      await handleMcpjsonServerApprovals(root)
    }

    // 检查 zy.md 中是否有需要审批的 include。
    if (await shouldShowAgentsMdExternalIncludesWarning()) {
      const externalIncludes = getExternalAgentsMdIncludes(await getMemoryFiles(true))
      const { agentsMdExternalIncludesDialog } = await import(
        '../components/AgentsMdExternalIncludesDialog.js'
      )
      const DialogComponent = agentsMdExternalIncludesDialog as React.ComponentType<{
        onDone: () => void
        isStandaloneDialog: boolean
        externalIncludes: unknown
      }>
      await showSetupDialog(root, (done) => (
        <DialogComponent onDone={done} isStandaloneDialog externalIncludes={externalIncludes} />
      ))
    }
  }

  // 记录当前仓库路径，供 teleport 切换目录使用；无需等待结果。
  // 必须在建立信任后执行，防止不受信任的目录污染映射。
  void updateGithubRepoPathMapping()
  if (feature('LODESTONE')) {
    updateDeepLinkTerminalPreference()
  }

  // 接受信任对话框后，或处于 bypass 模式时，应用完整环境变量。
  // bypass 模式（CI/CD、自动化）视环境为可信，因此应用所有变量；
  // 普通模式则等用户接受信任对话框后再执行，其中可能包含来自不受信任来源的危险环境变量。
  applyConfigEnvironmentVariables()

  // 应用环境变量后再初始化遥测，以便使用 OTEL endpoint 环境变量及必须在可信状态下执行的
  // otelHeadersHelper。延迟到下一个 tick，使 OTel 动态导入在首次渲染后解析，
  // 而不是占用渲染前的微任务队列。
  setImmediate(() => initializeTelemetryAfterTrust())

  // 检查环境变量中的 API key。
  // 在 homespace 上，ZY_API_KEY 会保留在 process.env 中供子进程使用，
  // 但 ZY Code 自身会忽略它（参见 auth.ts）。
  if (process.env.ZY_API_KEY && !isRunningOnHomespace()) {
    const apiKeyTruncated = normalizeApiKeyForConfig(process.env.ZY_API_KEY)
    const keyStatus = getApiKeyStatus(apiKeyTruncated)
    if (keyStatus === 'new') {
      const { ApproveApiKey } = await import('../components/ApproveApiKey.js')
      await showSetupDialog<boolean>(
        root,
        (done) => <ApproveApiKey apiKeyTruncated={apiKeyTruncated} onDone={done} />,
        {
          onChangeAppState,
        },
      )
    }
  }
  if (
    (permissionMode === 'bypassPermissions' || allowDangerouslySkipPermissions) &&
    !hasSkipDangerousModePermissionPrompt()
  ) {
    const { BypassPermissionsModeDialog } = await import(
      '../components/BypassPermissionsModeDialog.js'
    )
    await showSetupDialog(root, (done) => <BypassPermissionsModeDialog onAccept={done} />)
  }
  // 只有 auto 模式确实可用时才显示选择加入对话框。若门控拒绝访问
  //（组织不在允许列表或设置已禁用），再让用户同意不可用的功能没有意义；
  // verifyAutoModeGateAccess 通知会解释原因。
  if (permissionMode === 'auto' && !hasAutoModeOptIn()) {
    const { AutoModeOptInDialog } = await import('../components/AutoModeOptInDialog.js')
    await showSetupDialog(root, (done) => (
      <AutoModeOptInDialog onAccept={done} onDecline={() => gracefulShutdownSync(1)} declineExits />
    ))
  }

  // 确认 --dangerously-load-development-channels。接受后，将开发 channel 追加到
  // main.tsx 已设置的 --channels 列表。此选项不会绕过组织策略，gateChannelServer()
  // 仍会运行；它只用于绕过 --channels 的已批准服务器允许列表。
  if (feature('KAIROS') || feature('KAIROS_CHANNELS')) {
    // 此函数返回后，gateChannelServer 和 ChannelsNotice 会读取 zy_channels_gate。
    // 冷磁盘缓存（全新安装，或服务端新增该 flag 后首次运行）默认是 false，
    // 会在整个会话中静默丢弃 channel 通知，参见 gh#37026。
    // 若磁盘值已为 true，checkGate_CACHED_OR_BLOCKING 会立即返回；只有缓存未命中或
    // 陈旧值为 false 时才阻塞，并等待前面启动的同一个记忆化 initializeGrowthBook promise。
    // 同时也会预热下方开发 channel 对话框的 isChannelsEnabled() 检查。
    if (getAllowedChannels().length > 0 || (devChannels?.length ?? 0) > 0) {
      await checkGate_CACHED_OR_BLOCKING('zy_channels_gate')
    }
    if (devChannels && devChannels.length > 0) {
      const [{ isChannelsEnabled }, { getZyAIOAuthTokens }] = await Promise.all([
        import('../services/mcp/channelAllowlist.js'),
        import('../services/auth/auth.js'),
      ])
      // channel 被阻止（zy_channels_gate 关闭或无 OAuth）时跳过对话框；接受后立刻在
      // ChannelsNotice 看到“不可用”不如不显示对话框。但仍追加条目，使 ChannelsNotice
      // 能在阻止分支列出开发条目。此处 dev:true 用于 ChannelsNotice 中的 flag 标签
      //（hasNonDev 检查）；它同时授予的允许列表绕过在上游门控已阻止时没有实际作用。
      if (!isChannelsEnabled() || !getZyAIOAuthTokens()?.accessToken) {
        setAllowedChannels([
          ...getAllowedChannels(),
          ...devChannels.map((c) => ({
            ...c,
            dev: true,
          })),
        ])
        setHasDevChannels(true)
      } else {
        const { DevChannelsDialog } = await import('../components/DevChannelsDialog.js')
        await showSetupDialog(root, (done) => (
          <DevChannelsDialog
            channels={devChannels}
            onAccept={() => {
              // 逐条标记开发条目，避免同时传入两个 flag 时允许列表绕过扩散到 --channels 条目。
              setAllowedChannels([
                ...getAllowedChannels(),
                ...devChannels.map((c) => ({
                  ...c,
                  dev: true,
                })),
              ])
              setHasDevChannels(true)
              void done()
            }}
          />
        ))
      }
    }
  }

  // 为首次使用 Claude in Chrome 的用户显示 Chrome 引导。
  if (ClaudeInChrome && !getGlobalConfig().hasCompletedClaudeInChromeOnboarding) {
    const { ClaudeInChromeOnboarding } = await import('../components/ClaudeInChromeOnboarding.js')
    await showSetupDialog(root, (done) => <ClaudeInChromeOnboarding onDone={done} />)
  }
  return onboardingShown
}
export function getRenderContext(exitOnCtrlC: boolean): {
  renderOptions: RenderOptions
  getFpsMetrics: () => FpsMetrics | undefined
  stats: StatsStore
} {
  let lastFlickerTime = 0
  const baseOptions = getBaseRenderOptions(exitOnCtrlC)

  // stdin 覆盖生效时记录分析事件。
  if (baseOptions.stdin) {
    logEvent('zy_stdin_interactive', {})
  }
  const fpsTracker = new FpsTracker()
  const stats = createStatsStore()
  setStatsStore(stats)

  // Bench 模式：启用后以 JSONL 追加每帧各阶段耗时，供 bench/repl-scroll.ts 离线分析。
  // 捕获完整 TUI 渲染流水线（yoga → screen buffer → diff → optimize → stdout），
  // 以便用真实用户流程验证任一阶段的性能优化。
  const frameTimingLogPath = process.env.ZY_CODE_FRAME_TIMING_LOG
  return {
    getFpsMetrics: () => fpsTracker.getMetrics(),
    stats,
    renderOptions: {
      ...baseOptions,
      onFrame: (event) => {
        fpsTracker.record(event.durationMs)
        stats.observe('frame_duration_ms', event.durationMs)
        if (frameTimingLogPath && event.phases) {
          // 仅供 Bench、由环境变量门控的路径：同步写入，避免突然退出时丢帧。
          // ≤60fps 时每帧约 100 字节，开销可忽略。rss/cpu 各只需一次系统调用；
          // cpu 为累计值，由 bench 端计算差量。
          const line =
            // eslint-disable-next-line custom-rules/no-direct-json-operations -- tiny object, hot bench path
            `${JSON.stringify({
              total: event.durationMs,
              ...event.phases,
              rss: process.memoryUsage.rss(),
              cpu: process.cpuUsage(),
            })}\n`
          // eslint-disable-next-line custom-rules/no-sync-fs -- bench-only, sync so no frames dropped on exit
          appendFileSync(frameTimingLogPath, line)
        }
        // 对支持同步输出的终端跳过闪烁报告；DEC 2026 会缓冲 BSU/ESU 之间的内容，
        // 因此清屏与重绘是原子操作。
        if (isSynchronizedOutputSupported()) {
          return
        }
        for (const flicker of event.flickers) {
          if (flicker.reason === 'resize') {
            continue
          }
          const now = Date.now()
          if (now - lastFlickerTime < 1000) {
            logEvent('zy_ui_flicker', {
              desiredHeight: flicker.desiredHeight,
              actualHeight: flicker.availableHeight,
              reason: flicker.reason,
            } as unknown as Record<string, boolean | number | undefined>)
          }
          lastFlickerTime = now
        }
      },
    },
  }
}
