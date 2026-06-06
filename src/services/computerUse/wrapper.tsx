/**
 * `.call()` 覆盖——`ToolUseContext` 与 `bindSessionContext` 之间的薄适配层。
 * 通过 spread 展入 `client.ts` 中的 MCP 工具对象
 * （与 Chrome 渲染覆盖相同的模式，另加 `.call()`）。
 *
 * 封装闭包逻辑（构建新覆盖、锁门、权限合并、截图暂存）位于
 * `@ant/computer-use-mcp` 的 `bindSessionContext` 中。本文件在进程层面绑定一次，
 * 缓存分发器，并在每次调用时更新 `ToolUseContext` 中
 * 每调用可变的部分（`abortController`、`setToolJSX`、
 * `sendOSNotification`）。AppState 访问器也通过此 ref 读取——
 * 它们可能是稳定的，但我们不依赖这一点。
 *
 * 外部调用方通过 `client.ts` 中的懒加载 require 阔值访问此外层，
 * 由 GrowthBook 门标 `zy_malort_pedway`（见 gates.ts）控制运行时启用。
 */

import {
  bindSessionContext,
  type ComputerUseSessionContext,
  type CuCallToolResult,
  type CuPermissionRequest,
  type CuPermissionResponse,
  DEFAULT_GRANT_FLAGS,
  type ScreenshotDims,
} from '@ant/computer-use-mcp'
import * as React from 'react'
import { getSessionId } from '../../bootstrap/state.js'
import { ComputerUseApproval } from '../../components/permissions/ComputerUseApproval/ComputerUseApproval.js'
import type { Tool, ToolUseContext } from '../../Tool.js'
import { logForDebugging } from '../../utils/debug.js'
import { checkComputerUseLock, tryAcquireComputerUseLock } from './computerUseLock.js'
import { registerEscHotkey } from './escHotkey.js'
import { getChicagoCoordinateMode } from './gates.js'
import { getComputerUseHostAdapter } from './hostAdapter.js'
import { getComputerUseMCPRenderingOverrides } from './toolRendering.js'

type CallOverride = Pick<Tool, 'call'>['call']
type Binding = {
  ctx: ComputerUseSessionContext
  dispatch: (name: string, args: unknown) => Promise<CuCallToolResult>
}

/**
 * 缓存绑定——首次 `.call()` 时构建，在进程生命周期内复用。
 * 分发器闭包持有的截图 blob 在调用之间持续存在。
 *
 * `currentToolUseContext` 在每次调用时更新。`ctx` 中的每个 getter/回调
 * 均通过它读取，因此每调用的部分（`abortController`、
 * `setToolJSX`、`sendOSNotification`）始终是最新的。
 *
 * 模块级 `let` 是对「禁止模块作用域状态」规则（src/AGENTS.md）的有意例外：
 * 分发器闭包必须跨调用持续，以保留内部截图 blob，
 * 而 `ToolUseContext` 是每调用独有的。
 * 测试时需要注入缓存或串行运行。
 */
let binding: Binding | undefined
let currentToolUseContext: ToolUseContext | undefined
function tuc(): ToolUseContext {
  // 安全：`binding` 仅在 `currentToolUseContext` 设置后才填充。
  // 仅在 `ctx` 回调内部调用，而回调只在 dispatch 期间触发。
  return currentToolUseContext!
}
function formatLockHeld(holder: string): string {
  return `Computer use is in use by another Zy session (${holder.slice(0, 8)}…). Wait for that session to finish or run /exit there.`
}
export function buildSessionContext(): ComputerUseSessionContext {
  return {
    // ── 通过每调用 ref 即时读取状态 ─────────────────────────────
    getAllowedApps: () => tuc().getAppState().computerUseMcpState?.allowedApps ?? [],
    getGrantFlags: () => tuc().getAppState().computerUseMcpState?.grantFlags ?? DEFAULT_GRANT_FLAGS,
    // cc-2 尚无用户拒绝应用的 Settings 页面。
    getUserDeniedBundleIds: () => [],
    getSelectedDisplayId: () => tuc().getAppState().computerUseMcpState?.selectedDisplayId,
    getDisplayPinnedByModel: () =>
      tuc().getAppState().computerUseMcpState?.displayPinnedByModel ?? false,
    getDisplayResolvedForApps: () =>
      tuc().getAppState().computerUseMcpState?.displayResolvedForApps,
    getLastScreenshotDims: (): ScreenshotDims | undefined => {
      const d = tuc().getAppState().computerUseMcpState?.lastScreenshotDims
      return d
        ? ({
            ...d,
            // biome-ignore lint/suspicious/noExplicitAny: 第三方类型不完善
            displayId: (d as any).displayId ?? 0,
            // biome-ignore lint/suspicious/noExplicitAny: 第三方类型不完善
            originX: (d as any).originX ?? 0,
            // biome-ignore lint/suspicious/noExplicitAny: 第三方类型不完善
            originY: (d as any).originY ?? 0,
            // biome-ignore lint/suspicious/noExplicitAny: 第三方类型不完善
          } as any)
        : undefined
    },
    // ── 写回 ────────────────────────────────────────────────────────
    // `setToolJSX` 将必存在——main.tsx 中的门标排除了非交互式会话。包的
    // `_dialogSignal`（工具完成后关闭对话框）在这里不相关：`setToolJSX` 会阻塞工具调用，
    // 因此对话框不会超出其存活时间。Ctrl+C 才是关键，
    // `runPermissionDialog` 从每调用 ref 的 abortController 中连接。
    onPermissionRequest: (req: CuPermissionRequest, _dialogSignal: AbortSignal) =>
      runPermissionDialog(req),
    // 包负责合并（去重复 + 指定为真的标志）。我们只需持久化。
    onAllowedAppsChanged: (
      apps: readonly { bundleId: string; displayName: string; grantedAt: number }[],
      flags: { clipboardRead: boolean; clipboardWrite: boolean; systemKeyCombos: boolean },
    ) =>
      tuc().setAppState((prev) => {
        const cu = prev.computerUseMcpState
        const prevApps = cu?.allowedApps
        const prevFlags = cu?.grantFlags
        const sameApps =
          prevApps?.length === apps.length &&
          apps.every((a, i) => prevApps![i]?.bundleId === a.bundleId)
        const sameFlags =
          prevFlags?.clipboardRead === flags.clipboardRead &&
          prevFlags?.clipboardWrite === flags.clipboardWrite &&
          prevFlags?.systemKeyCombos === flags.systemKeyCombos
        return sameApps && sameFlags
          ? prev
          : {
              ...prev,
              computerUseMcpState: {
                ...cu,
                allowedApps: [...apps],
                grantFlags: flags,
              },
            }
      }),
    onAppsHidden: (ids: string[]) => {
      if (ids.length === 0) {
        return
      }
      tuc().setAppState((prev) => {
        const cu = prev.computerUseMcpState
        const existing = cu?.hiddenDuringTurn
        if (existing && ids.every((id: string) => existing.has(id))) {
          return prev
        }
        return {
          ...prev,
          computerUseMcpState: {
            ...cu,
            hiddenDuringTurn: new Set([...(existing ?? []), ...ids]),
          },
        }
      })
    },
    // 仅在 pin 激活且 Swift 回退到主显示器时触发解析器回写
    // （已 pin 的显示器拔出）——pin 语义上已失效，清除它
    // 和 app-set 键，下次进行追踪链。当 autoResolve 为 true 时，
    // onDisplayResolvedForApps 会在同一节拍重新设置该键。
    onResolvedDisplayUpdated: (id: number) =>
      tuc().setAppState((prev) => {
        const cu = prev.computerUseMcpState
        if (
          cu?.selectedDisplayId === id &&
          !cu?.displayPinnedByModel &&
          cu?.displayResolvedForApps === undefined
        ) {
          return prev
        }
        return {
          ...prev,
          computerUseMcpState: {
            ...cu,
            selectedDisplayId: id,
            displayPinnedByModel: false,
            displayResolvedForApps: undefined,
          },
        }
      }),
    // switch_display(name) 会 pin ；switch_display("auto") 会 unpin 并清除
    // app-set 键，下一次截图自动重新解析。
    onDisplayPinned: (id: number | undefined) =>
      tuc().setAppState((prev) => {
        const cu = prev.computerUseMcpState
        const pinned = id !== undefined
        const nextResolvedFor = pinned ? cu?.displayResolvedForApps : undefined
        if (
          cu?.selectedDisplayId === id &&
          cu?.displayPinnedByModel === pinned &&
          cu?.displayResolvedForApps === nextResolvedFor
        ) {
          return prev
        }
        return {
          ...prev,
          computerUseMcpState: {
            ...cu,
            selectedDisplayId: id,
            displayPinnedByModel: pinned,
            displayResolvedForApps: nextResolvedFor,
          },
        }
      }),
    onDisplayResolvedForApps: (key: string | undefined) =>
      tuc().setAppState((prev) => {
        const cu = prev.computerUseMcpState
        if (cu?.displayResolvedForApps === key) {
          return prev
        }
        return {
          ...prev,
          computerUseMcpState: {
            ...cu,
            displayResolvedForApps: key,
          },
        }
      }),
    onScreenshotCaptured: (dims: {
      width: number
      height: number
      displayWidth: number
      displayHeight: number
      displayId?: number
      originX?: number
      originY?: number
    }) =>
      tuc().setAppState((prev) => {
        const cu = prev.computerUseMcpState
        const p = cu?.lastScreenshotDims
        return p?.width === dims.width &&
          p?.height === dims.height &&
          p?.displayWidth === dims.displayWidth &&
          p?.displayHeight === dims.displayHeight &&
          p?.displayId === dims.displayId &&
          p?.originX === dims.originX &&
          p?.originY === dims.originY
          ? prev
          : {
              ...prev,
              computerUseMcpState: {
                ...cu,
                lastScreenshotDims: dims,
              },
            }
      }),
    // ── 锁——异步，直接调用文件锁 ───────────────────────────────
    // 无需 `lockHolderForGate` 逻辑：包的门标现在是异步的。它
    // 等待 `checkCuLock`，尚且 `holder: undefined` + 非延迟锁工具时
    // 等待 `acquireCuLock`。`defersLockAcquire` 是包的集合——
    // 本地副本已删除。
    checkCuLock: async () => {
      const c = await checkComputerUseLock()
      switch (c.kind) {
        case 'free':
          return {
            holder: undefined,
            isSelf: false,
          }
        case 'held_by_self':
          return {
            holder: getSessionId(),
            isSelf: true,
          }
        case 'blocked':
          return {
            holder: c.by,
            isSelf: false,
          }
      }
    },
    // 仅当 checkCuLock 返回 `holder: undefined` 时调用。O_EXCL
    // 获取是原子的——若其他进程在间隙中抢占（极少发生），
    // 抛出异常使工具失败，而非在无锁的情况下继续。
    // `fresh: false`（重入）理论上不应发生（检查说是 free），
    // 但并行工具用下交错可能出现——此时请勿刷屏通知。
    acquireCuLock: async () => {
      const r = await tryAcquireComputerUseLock()
      if (r.kind === 'blocked') {
        throw new Error(formatLockHeld(r.by))
      }
      if (r.fresh) {
        // 全局 Escape → 中止。消耗事件（PI 防御——提示词注入无法用 Escape 关闭对话框）。
        // CGEventTap 的 CFRunLoopSource 由 drainRunLoop pump 处理，
        // 因此在 unregisterEscHotkey() 清理之前保持 pump retain。
        const escRegistered = registerEscHotkey(() => {
          logForDebugging('[cu-esc] user escape, aborting turn')
          tuc().abortController.abort()
        })
        tuc().sendOSNotification?.({
          message: escRegistered
            ? 'Zy is using your computer · press Esc to stop'
            : 'Zy is using your computer · press Ctrl+C to stop',
          notificationType: 'computer_use_enter',
        })
      }
    },
    formatLockHeldMessage: formatLockHeld,
  }
}
function getOrBind(): Binding {
  if (binding) {
    return binding
  }
  const ctx = buildSessionContext()
  binding = {
    ctx,
    // biome-ignore lint/suspicious/noExplicitAny: 第三方原生模块类型不完善
    dispatch: (bindSessionContext as any)(
      getComputerUseHostAdapter(),
      getChicagoCoordinateMode(),
      ctx,
    ),
  }
  return binding
}

/**
 * 返回单个 `mcp__computer-use__{toolName}` 工具的完整覆盖对象：
 * 来自 `toolRendering.tsx` 的渲染覆盖加上通过缓存绑定分发的 `.call()`。
 */
type ComputerUseMCPToolOverrides = ReturnType<typeof getComputerUseMCPRenderingOverrides> & {
  call: CallOverride
}
export function getComputerUseMCPToolOverrides(toolName: string): ComputerUseMCPToolOverrides {
  const call: CallOverride = async (args, context: ToolUseContext) => {
    currentToolUseContext = context
    const { dispatch } = getOrBind()
    // biome-ignore lint/suspicious/noExplicitAny: 第三方原生模块类型不完善
    const dispatchResult = (await dispatch(toolName, args)) as any
    const { telemetry, ...result } = dispatchResult
    if (telemetry?.error_kind) {
      logForDebugging(`[Computer Use MCP] ${toolName} error_kind=${telemetry.error_kind}`)
    }

    // MCP 内容块 → Anthropic API 块。CU 仅产生文本和
    // 预先设定大小的 JPEG（executor.ts computeTargetDims → targetImageSize），
    // 与通用 MCP 路径不同，无需调整大小——MCP image
    // 形状直接映射到 API 的 base64-source 形状。包的结果
    // 类型也允许 audio/resource，但 CU 的 handleToolCall 永远不会发出
    // 这些；默写将它们强制转换为空文本。
    const data = Array.isArray(result.content)
      ? // biome-ignore lint/suspicious/noExplicitAny: 第三方原生模块类型不完善
        result.content.map((item: any) =>
          item.type === 'image'
            ? {
                type: 'image' as const,
                source: {
                  type: 'base64' as const,
                  mediaType: item.mimeType ?? 'image/jpeg',
                  data: item.data,
                },
              }
            : {
                type: 'text' as const,
                text: item.type === 'text' ? item.text : '',
              },
        )
      : result.content
    return {
      data,
    }
  }
  return {
    ...getComputerUseMCPRenderingOverrides(toolName),
    call,
  }
}

/**
 * 通过 `setToolJSX` + `Promise` 在调用中渲染权限对话框，等待用户操作。
 * 模式参考 `spawnMultiAgent.ts:419-436`（`It2SetupPrompt` 模式）。
 *
 * 原先位于此处的 AppState 合并逻辑（去重复 + 指定为真的标志）
 * 已移至包的 `bindSessionContext` → `onAllowedAppsChanged`。
 */
async function runPermissionDialog(req: CuPermissionRequest): Promise<CuPermissionResponse> {
  const context = tuc()
  const setToolJSX = context.setToolJSX
  if (!setToolJSX) {
    // 不应发生——main.tsx 门标排除了非交互式会话。安全失败。
    return {
      granted: [],
      denied: [],
      flags: DEFAULT_GRANT_FLAGS,
    }
  }
  try {
    return await new Promise<CuPermissionResponse>((resolve, reject) => {
      const signal = context.abortController.signal
      // 若已中止，addeventListener 不会触发——立即 reject，
      // 避免 promise 在用户已 Ctrl+C 后悬挂等待。
      if (signal.aborted) {
        reject(new Error('Computer Use permission dialog aborted'))
        return
      }
      const onAbort = (): void => {
        signal.removeEventListener('abort', onAbort)
        reject(new Error('Computer Use permission dialog aborted'))
      }
      signal.addEventListener('abort', onAbort)
      setToolJSX({
        jsx: React.createElement(ComputerUseApproval, {
          request: req,
          onDone: (resp: CuPermissionResponse) => {
            signal.removeEventListener('abort', onAbort)
            resolve(resp)
          },
        }),
        shouldHidePromptInput: true,
      })
    })
  } finally {
    setToolJSX(null)
  }
}
