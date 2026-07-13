import { profileCheckpoint } from '../utils/startupProfiler.js'
import '../bootstrap/state.js'
import '../utils/config.js'
import type { Attributes, MetricOptions } from '@opentelemetry/api'
import memoize from 'lodash-es/memoize.js'
import { getIsNonInteractiveSession } from 'src/bootstrap/state.js'
import type { AttributedCounter } from '../bootstrap/state.js'
import { getSessionCounter, setMeter } from '../bootstrap/state.js'
import { shutdownLspServerManager } from '../services/lsp/manager.js'
import {
  initializePolicyLimitsLoadingPromise,
  isPolicyLimitsEligible,
} from '../services/policy-limits/index.js'
import {
  initializeRemoteManagedSettingsLoadingPromise,
  isEligibleForRemoteManagedSettings,
  waitForRemoteManagedSettingsToLoad,
} from '../services/remote-managed-settings/index.js'
import { isBetaTracingEnabled } from '../services/telemetry/betaSessionTracing.js'
import { preconnectAnthropicApi } from '../utils/apiPreconnect.js'
import { populateOAuthAccountInfoIfNeeded } from '../utils/auth.js'
import { applyExtraCACertsFromConfig } from '../utils/caCertsConfig.js'
import { registerCleanup } from '../utils/cleanupRegistry.js'
import { enableConfigs, recordFirstStartTime } from '../utils/config.js'
import { createDebugLog } from '../utils/debug.js'
import { detectCurrentRepository } from '../utils/detectRepository.js'
import { logForDiagnosticsNoPII } from '../utils/diagLogs.js'
import { initJetBrainsDetection } from '../utils/envDynamic.js'
import { isEnvTruthy } from '../utils/envUtils.js'
import { ConfigParseError, errorMessage } from '../utils/errors.js'
// showInvalidConfigDialog 在错误路径中动态导入，以避免在初始化时加载 React
import { gracefulShutdownSync, setupGracefulShutdown } from '../utils/gracefulShutdown.js'
import {
  applyConfigEnvironmentVariables,
  applySafeConfigEnvironmentVariables,
} from '../utils/managedEnv.js'
import { configureGlobalMTLS } from '../utils/mtls.js'
import { ensureScratchpadDir, isScratchpadEnabled } from '../utils/permissions/filesystem.js'
// initializeTelemetry 通过 setMeterState() 中的 import() 延迟加载，以推迟
// ~400KB 的 OpenTelemetry + protobuf 模块，直到真正初始化遥测时才加载。
// gRPC 导出器（通过 @grpc/grpc-js 约 ~700KB）在 instrumentation.ts 中进一步延迟加载。
import { configureGlobalAgents } from '../utils/proxy.js'
import { getTelemetryAttributes } from '../utils/telemetryAttributes.js'
import { setShellIfWindows } from '../utils/windowsPaths.js'

const log = createDebugLog('init')

// initializeZyEventLogging 动态导入以延迟加载 OpenTelemetry sdk-logs/resources

// 跟踪遥测是否已初始化，防止重复初始化
let telemetryInitialized = false

export const init = memoize(async (): Promise<void> => {
  const initStartTime = Date.now()
  logForDiagnosticsNoPII('info', 'init_started')
  profileCheckpoint('init_function_start')

  // 验证配置有效并启用配置系统
  try {
    const configsStart = Date.now()
    enableConfigs()
    logForDiagnosticsNoPII('info', 'init_configs_enabled', {
      duration_ms: Date.now() - configsStart,
    })
    profileCheckpoint('init_configs_enabled')

    // 在信任对话框之前仅应用安全的环境变量
    // 完整的环境变量在建立信任后应用
    const envVarsStart = Date.now()
    applySafeConfigEnvironmentVariables()

    // 尽早将 settings.json 中的 NODE_EXTRA_CA_CERTS 应用到 process.env，
    // 在任何 TLS 连接之前。Bun 在启动时通过 BoringSSL 缓存 TLS 证书存储，
    // 因此这必须在第一次 TLS 握手之前完成。
    applyExtraCACertsFromConfig()

    logForDiagnosticsNoPII('info', 'init_safe_env_vars_applied', {
      duration_ms: Date.now() - envVarsStart,
    })
    profileCheckpoint('init_safe_env_vars_applied')

    // 确保在退出时刷新数据
    setupGracefulShutdown()
    profileCheckpoint('init_after_graceful_shutdown')

    // 初始化 ZY 事件日志（无安全问题，但延迟加载以避免
    // 启动时加载 OpenTelemetry sdk-logs）。growthbook.js 此时已在
    // 模块缓存中（zyEventLogger 导入了它），因此
    // 第二次动态导入不会增加加载开销。
    void Promise.all([
      import('../services/analytics/zyEventLogger.js'),
      import('../services/analytics/growthbook.js'),
    ])
      .then(([fp, gb]) => {
        fp.initializeZyEventLogging()
        // 如果 zy_1p_event_batch_config 在会话中
        // 途变化，重新初始化日志 provider。变化检测（isEqual）在
        // handler 内部，因此未变化的刷新是空操作。
        gb.onGrowthBookRefresh(() => {
          void fp.reinitializeZyEventLoggingIfConfigChanged()
        })
      })
      .catch((error: unknown) => {
        // 之前这里没有 .catch，任何 import/init 异常都会变成 unhandled rejection
        // 静默消失，~/.zy/telemetry/zy_events.log 永远不生成。加 catch 让失败可观测。
        const message = error instanceof Error ? error.message : String(error)
        log(`1P event logging init failed: ${message}`, { level: 'warn' })
      })
    profileCheckpoint('init_after_1p_event_logging')

    // 如果 OAuth 账号信息尚未缓存到配置中，则填充它。这是必要的，因为
    // 通过 VSCode 扩展登录时可能未填充 OAuth 账号信息。
    // 包裹在 try-catch 中以防止 OAuth 错误阻塞初始化过程
    void populateOAuthAccountInfoIfNeeded().catch((_error) => {
      log('OAuth account info population failed during init', {
        level: 'warn',
      })
    })
    profileCheckpoint('init_after_oauth_populate')

    // 异步初始化 JetBrains IDE 检测（填充缓存供后续同步访问）
    void initJetBrainsDetection()
    profileCheckpoint('init_after_jetbrains_detection')

    // 异步检测 GitHub 仓库（填充缓存用于 gitDiff PR 链接）
    void detectCurrentRepository()

    // 尽早初始化加载 promise，以便其他系统（如插件钩子）
    // 可以等待远程设置加载完成。该 promise 包含超时机制，
    // 以防止 loadRemoteManagedSettings() 从未被调用时发生死锁（如 Agent SDK 测试）。
    if (isEligibleForRemoteManagedSettings()) {
      initializeRemoteManagedSettingsLoadingPromise()
    }
    if (isPolicyLimitsEligible()) {
      initializePolicyLimitsLoadingPromise()
    }
    profileCheckpoint('init_after_remote_settings_check')

    // 记录首次启动时间
    recordFirstStartTime()

    // 配置全局 mTLS 设置
    const mtlsStart = Date.now()
    log('[init] configureGlobalMTLS starting')
    configureGlobalMTLS()
    logForDiagnosticsNoPII('info', 'init_mtls_configured', {
      duration_ms: Date.now() - mtlsStart,
    })
    log('[init] configureGlobalMTLS complete')

    // 配置全局 HTTP 代理（proxy 和/或 mTLS）
    const proxyStart = Date.now()
    log('[init] configureGlobalAgents starting')
    configureGlobalAgents()
    logForDiagnosticsNoPII('info', 'init_proxy_configured', {
      duration_ms: Date.now() - proxyStart,
    })
    log('[init] configureGlobalAgents complete')
    profileCheckpoint('init_network_configured')

    // 预连接到 Anthropic API —— 将 TCP+TLS 握手（约 100-200ms）
    // 与 API 请求前约 100ms 的 action-handler 工作重叠执行。
    // 在 CA 证书 + 代理代理配置完成后进行，以确保预热的连接
    // 使用正确的传输方式。即发即忘；对于代理/mTLS/unix/云提供商
    // 场景跳过，因为 SDK 的 dispatcher 不会复用全局连接池。
    preconnectAnthropicApi()

    // CCR upstreamproxy：启动本地 CONNECT 中继，使 agent 子进程
    // 能够通过凭证注入访问组织配置的上游服务。受
    // ZY_CODE_REMOTE + GrowthBook 门控；任何错误时 fail-open。延迟导入，
    // 因此非 CCR 启动不会承担模块加载开销。getUpstreamProxyEnv
    // 函数注册到 subprocessEnv.ts，因此子进程派生时可以
    // 注入代理变量，无需静态导入 upstreamproxy 模块。
    if (isEnvTruthy(process.env.ZY_CODE_REMOTE)) {
      try {
        const { initUpstreamProxy, getUpstreamProxyEnv } = await import(
          '../upstreamproxy/upstreamproxy.js'
        )
        const { registerUpstreamProxyEnvFn } = await import('../utils/subprocessEnv.js')
        registerUpstreamProxyEnvFn(getUpstreamProxyEnv)
        await initUpstreamProxy()
      } catch (err) {
        log(
          `[init] upstreamproxy init failed: ${err instanceof Error ? err.message : String(err)}; continuing without proxy`,
          { level: 'warn' },
        )
      }
    }

    // 设置 git-bash（如适用）
    setShellIfWindows()

    // 注册 LSP 管理器清理函数（初始化发生在 main.tsx 中处理 --plugin-dir 之后）
    registerCleanup(shutdownLspServerManager)

    // gh-32730：子 agent（或未显式调用 TeamDelete 的主 agent）创建的
    // 团队会永久残留在磁盘上。为此会话创建的所有团队注册清理函数。
    // 延迟导入：swarm 代码受 feature gate 保护，大多数会话不会创建团队。
    registerCleanup(async () => {
      const { cleanupSessionTeams } = await import('../services/swarm/teamHelpers.js')
      await cleanupSessionTeams()
    })

    // 如果启用了 scratchpad，则初始化 scratchpad 目录
    if (isScratchpadEnabled()) {
      const scratchpadStart = Date.now()
      await ensureScratchpadDir()
      logForDiagnosticsNoPII('info', 'init_scratchpad_created', {
        duration_ms: Date.now() - scratchpadStart,
      })
    }

    logForDiagnosticsNoPII('info', 'init_completed', {
      duration_ms: Date.now() - initStartTime,
    })
    profileCheckpoint('init_function_end')
  } catch (error) {
    if (error instanceof ConfigParseError) {
      // 当无法安全渲染时跳过交互式 Ink 对话框。
      // 该对话框会导致 JSON 消费者出错（如在 VM 沙箱中运行
      // `plugin marketplace list --json` 的桌面市场插件管理器）。
      if (getIsNonInteractiveSession()) {
        process.stderr.write(`Configuration error in ${error.filePath}: ${error.message}\n`)
        gracefulShutdownSync(1)
        return
      }

      // 显示无效配置对话框并等待其完成
      return import('../components/InvalidConfigDialog.js').then((m) =>
        m.showInvalidConfigDialog({ error }),
      )
      // 对话框本身处理 process.exit，因此无需额外清理
    } else {
      // 对于非配置错误，重新抛出
      throw error
    }
  }
})

/**
 * 在用户授予信任后初始化遥测。
 * 对于符合远程设置条件的用户，等待设置加载完成（非阻塞），
 * 然后在初始化遥测之前重新应用环境变量（以包含远程设置）。
 * 对于不符合条件的用户，立即初始化遥测。
 * 此函数仅应在接受信任对话框后调用一次。
 */
export function initializeTelemetryAfterTrust(): void {
  if (isEligibleForRemoteManagedSettings()) {
    // 对于启用 beta tracing 的 SDK/无头模式，首先急切初始化
    // 以确保 tracer 在第一次查询运行前就绪。
    // 下面的异步路径仍会执行，但 doInitializeTelemetry() 会防止重复初始化。
    if (getIsNonInteractiveSession() && isBetaTracingEnabled()) {
      void doInitializeTelemetry().catch((error) => {
        log(`[3P telemetry] Eager telemetry init failed (beta tracing): ${errorMessage(error)}`, {
          level: 'error',
        })
      })
    }
    log('[3P telemetry] Waiting for remote managed settings before telemetry init')
    void waitForRemoteManagedSettingsToLoad()
      .then(async () => {
        log('[3P telemetry] Remote managed settings loaded, initializing telemetry')
        // 在初始化遥测之前重新应用环境变量，以获取远程设置。
        applyConfigEnvironmentVariables()
        await doInitializeTelemetry()
      })
      .catch((error) => {
        log(`[3P telemetry] Telemetry init failed (remote settings path): ${errorMessage(error)}`, {
          level: 'error',
        })
      })
  } else {
    void doInitializeTelemetry().catch((error) => {
      log(`[3P telemetry] Telemetry init failed: ${errorMessage(error)}`, {
        level: 'error',
      })
    })
  }
}

async function doInitializeTelemetry(): Promise<void> {
  if (telemetryInitialized) {
    // 已初始化，无需任何操作
    return
  }

  // 在初始化之前设置标志，防止重复初始化
  telemetryInitialized = true
  try {
    await setMeterState()
  } catch (error) {
    // 失败时重置标志，以便后续调用可以重试
    telemetryInitialized = false
    throw error
  }
}

async function setMeterState(): Promise<void> {
  // 延迟加载 instrumentation，以推迟 ~400KB 的 OpenTelemetry + protobuf
  const { initializeTelemetry } = await import('../services/telemetry/instrumentation.js')
  // 初始化客户 OTLP 遥测（metrics, logs, traces）
  const meter = await initializeTelemetry()
  if (meter) {
    // 创建带属性计数器的工厂函数
    const createAttributedCounter = (name: string, options: MetricOptions): AttributedCounter => {
      const counter = meter?.createCounter(name, options)

      return {
        add(value: number, additionalAttributes: Attributes = {}) {
          // 始终获取最新的遥测属性以确保数据是最新的
          const currentAttributes = getTelemetryAttributes()
          const mergedAttributes = {
            ...currentAttributes,
            ...additionalAttributes,
          }
          counter?.add(value, mergedAttributes)
        },
      }
    }

    setMeter(meter, createAttributedCounter)

    // 在此处增加会话计数器，因为启动时的遥测路径
    // 在此异步初始化完成前运行，因此那里的计数器会为 null。
    getSessionCounter()?.add(1)
  }
}
