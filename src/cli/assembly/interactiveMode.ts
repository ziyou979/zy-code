// 默认 interactive 模式装配。
// 对应原 root.ts:3570-3635 else 分支：无 resume / connect / ssh / remote 触发时的 REPL 启动。

import { feature } from 'bun:bundle'
import { launchRepl } from '../../cli/ReplLauncher.js'
import { logEvent } from '../../services/analytics/index.js'
import { buildDeepLinkBanner } from '../../services/deep-link/banner.js'
import type { Message } from '../../types/message.js'
import { getCwd } from '../../utils/cwd.js'
import { createSystemMessage } from '../../services/messages/./constructors.js'
import { saveMode } from '../../services/sessionStorage.js'
import { profileCheckpoint } from '../../services/telemetry/startupProfiler.js'
import { maybeActivateBrief } from '../activate/brief.js'
import { maybeActivateProactive } from '../activate/proactive.js'
import { coordinatorModeModule } from '../lazyModules.js'
import type { AssemblyContext, SessionConfig } from './types.js'
// rootAction 第 3570 行 else 分支需要的 options 字段。
// 用结构化子集避免把整个 rootAction options（any）拖进来。
export type InteractiveModeOptions = {
  deepLinkOrigin?: unknown
  deepLinkRepo?: string
  deepLinkLastFetch?: number
  prefill?: string
  // maybeActivateProactive / maybeActivateBrief 内部读取 options 的其它字段，
  // 仍按 any 透传，等 Phase 1 后续把 options 类型化时一并收敛。
  [key: string]: unknown
}

export type InteractiveModeParams = AssemblyContext & {
  sessionConfig: SessionConfig
  options: InteractiveModeOptions
  // SessionStart hooks 注入的初始消息和异步 promise，
  // hookMessages 已就绪时为同步注入；hooksPromise 仅在尚未就绪时透传给 REPL。
  hookMessages: Message[]
  // 与 root.ts:2044 一致：未触发钩子时为 null，触发后是 Promise，已落到数组后允许传 undefined。
  hooksPromise: Promise<Message[]> | null | undefined
}

export async function runInteractiveMode({
  root,
  appProps,
  renderAndRun,
  sessionConfig,
  options,
  hookMessages,
  hooksPromise,
}: InteractiveModeParams): Promise<void> {
  // 将未解决的钩子 promise 传递给 REPL，以便它可以立即渲染
  // 而不是阻塞约 500ms 等待 SessionStart 钩子完成。
  // REPL 将在钩子解析时注入钩子消息，并在
  // 首次 API 调用之前等待它们，以便模型始终看到钩子上下文。
  const pendingHookMessages = hooksPromise && hookMessages.length === 0 ? hooksPromise : undefined

  profileCheckpoint('action_after_hooks')
  maybeActivateProactive(options)
  maybeActivateBrief(options)
  // 为新会话持久化当前模式，以便未来的恢复知道使用了什么模式
  if (feature('COORDINATOR_MODE')) {
    saveMode(coordinatorModeModule?.isCoordinatorMode() ? 'coordinator' : 'normal')
  }

  // 如果通过深度链接启动，显示来源横幅以便用户
  // 知道会话是从外部启动的。Linux xdg-open 和
  // 设置了"始终允许"的浏览器在没有操作系统级别
  // 确认的情况下分派链接，所以这是用户得到的唯一信号
  // 提示 —— 以及它暗示的工作目录 / AGENTS.md —— 来自
  // 外部来源，而不是他们输入的内容。
  let deepLinkBanner: ReturnType<typeof createSystemMessage> | null = null
  if (feature('LODESTONE')) {
    if (options.deepLinkOrigin) {
      logEvent('zy_deep_link_opened', {
        has_prefill: Boolean(options.prefill),
        has_repo: Boolean(options.deepLinkRepo),
      })
      deepLinkBanner = createSystemMessage(
        buildDeepLinkBanner({
          cwd: getCwd(),
          prefillLength: options.prefill?.length,
          repo: options.deepLinkRepo,
          lastFetch:
            options.deepLinkLastFetch !== undefined
              ? new Date(options.deepLinkLastFetch)
              : undefined,
        }),
        'warning',
      )
    } else if (options.prefill) {
      deepLinkBanner = createSystemMessage(
        'Launched with a pre-filled prompt — review it before pressing Enter.',
        'warning',
      )
    }
  }
  const initialMessages = deepLinkBanner
    ? [deepLinkBanner, ...hookMessages]
    : hookMessages.length > 0
      ? hookMessages
      : undefined

  await launchRepl(
    root,
    appProps,
    {
      ...sessionConfig,
      initialMessages,
      pendingHookMessages,
    },
    renderAndRun,
  )
}
