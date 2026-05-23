import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import { getSystemContext, getUserContext } from '../../context.js'
import { warmI18n } from '../../i18n/index.js'
import { initializeAnalyticsGates } from '../../services/analytics/sink.js'
import { prefetchOfficialMcpUrls } from '../../services/mcp/officialRegistry.js'
import { getRelevantTips } from '../../services/tips/tipRegistry.js'
import { checkHasTrustDialogAccepted } from '../../utils/config.js'
import { getCwd } from '../../utils/cwd.js'
import { logForDiagnosticsNoPII } from '../../utils/diagLogs.js'
import { isBareMode, isEnvTruthy, isInternalBuild } from '../../utils/envUtils.js'
import { refreshModelCapabilities } from '../../utils/model/modelCapabilities.js'
import { countFilesRoundedRg } from '../../utils/ripgrep.js'
import { settingsChangeDetector } from '../../utils/settings/changeDetector.js'
import { skillChangeDetector } from '../../utils/skills/skillChangeDetector.js'
import { initUser } from '../../utils/user.js'

/**
 * 仅在安全的情况下预取系统上下文（包括 git 状态）。
 * Git 命令可以通过钩子和配置执行任意代码（例如 core.fsmonitor、
 * diff.external），因此我们必须在建立信任后或在
 * 信任是隐式的非交互模式下才能运行它们。
 */
function prefetchSystemContextIfSafe(): void {
  const isNonInteractiveSession = getIsNonInteractiveSession()

  // 在非交互模式（--print）下，跳过信任对话框且
  // 执行被视为受信任的（如帮助文本中所述）
  if (isNonInteractiveSession) {
    logForDiagnosticsNoPII('info', 'prefetch_system_context_non_interactive')
    void getSystemContext()
    return
  }

  // 在交互模式下，仅在已建立信任时才预取
  const hasTrust = checkHasTrustDialogAccepted()
  if (hasTrust) {
    logForDiagnosticsNoPII('info', 'prefetch_system_context_has_trust')
    void getSystemContext()
  } else {
    logForDiagnosticsNoPII('info', 'prefetch_system_context_skipped_no_trust')
  }
  // 否则，不预取 —— 等待信任建立后再进行
}

/**
 * 启动首次渲染不需要的后台预取和清理工作。
 * 这些从 setup() 中延迟出来，以减少事件循环竞争和
 * 关键启动路径中的子进程生成。
 * 在 REPL 渲染后调用此函数。
 */
export function startDeferredPrefetches(): void {
  // 此函数在首次渲染后运行，因此不会阻塞初始绘制。
  // 但是，生成的子进程和异步工作仍然会竞争 CPU 和事件
  // 循环时间，这会扭曲启动基准测试（CPU 配置文件、首次渲染时间
  // 测量）。仅在测量启动性能时跳过所有这些操作。
  if (
    isEnvTruthy(process.env.ZY_CODE_EXIT_AFTER_FIRST_RENDER) ||
    // --bare：跳过所有预取。这些是 REPL 首次响应性的缓存预热
    //（initUser、getUserContext、tips、countFiles、
    // modelCapabilities、change detectors）。脚本化的 -p 调用没有
    // "用户正在输入"的时间窗口来隐藏这些工作 —— 它是关键路径上的纯开销。
    isBareMode()
  ) {
    return
  }

  // 生成子进程的预取（在首次 API 调用时使用，用户仍在输入）
  void initUser()
  void getUserContext()
  prefetchSystemContextIfSafe()
  void getRelevantTips()
  void warmI18n()
  void countFilesRoundedRg(getCwd(), AbortSignal.timeout(3000), [])

  // 分析数据和功能标志初始化
  void initializeAnalyticsGates()
  void prefetchOfficialMcpUrls()
  void refreshModelCapabilities()

  // 文件变更检测器从 init() 延迟以不阻塞首次渲染
  void settingsChangeDetector.initialize()
  if (!isBareMode()) {
    void skillChangeDetector.initialize()
  }

  // 事件循环停顿检测器 —— 当主线程阻塞超过 500ms 时记录日志
  if (isInternalBuild()) {
    void import('../../utils/eventLoopStallDetector.js').then((m: any) =>
      m.startEventLoopStallDetector(),
    )
  }
}
