// @ts-nocheck
/**
 * CLI 端的 `ComputerExecutor` 实现。封装了两个原生模块：
 *   - `@ant/computer-use-input`（Rust/enigo）—— mouse、keyboard、前台应用
 *   - `@ant/computer-use-swift` —— SCContentFilter 截屏、NSWorkspace 应用管理、TCC
 *
 * 契约：apps 仓库中的 `packages/desktop/computer-use-mcp/src/executor.ts`。
 * 参考实现为 Cowork 的 `apps/desktop/src/main/nest-only/computer-use/executor.ts`
 * —— 以下"CLI 差异"部分说明了本实现与其的区别。
 *
 * ── 与 Cowork 的 CLI 差异 ──────────────────────────────────────────────────
 *
 * 无 `withClickThrough`。Cowork 在每次 mouse 操作前后通过
 *   `BrowserWindow.setIgnoreMouseEvents(true)` 使点击穿透覆盖层。我们运行在
 *   终端中（没有窗口），所以 click-through 逻辑在此为空操作。哨兵值
 *   `CLI_HOST_BUNDLE_ID` 永远不会匹配前台应用。
 *
 * 终端作为代理宿主。`getTerminalBundleId()` 检测我们所在的终端模拟器。
 *   它作为 `hostBundleId` 传给 `prepareDisplay`/`resolvePrepareCapture`，
 *   使 Swift 端将其从隐藏中豁免，并在 activate z-order 遍历中跳过它（这样终端
 *   位于前台时不会吞掉发往目标应用的点击）。同时通过 `withoutTerminal()` 从
 *   `allowedBundleIds` 中剔除，使截屏不会捕获终端（Swift 0.2.1 的
 *   captureExcluding 虽名为"排除"实际接收的是允许列表 —— apps#30355）。
 *   `capabilities.hostBundleId` 仍使用哨兵值 —— 包内的前台门控使用它，
 *   而终端处于前台是允许的。
 *
 * 剪贴板通过 `pbcopy`/`pbpaste` 实现。没有 Electron `clipboard` 模块。
 */

import type {
  ComputerExecutor,
  DisplayGeometry,
  FrontmostApp,
  InstalledApp,
  ResolvePrepareCaptureResult,
  RunningApp,
  ScreenshotResult,
} from '@ant/computer-use-mcp'

import { API_RESIZE_PARAMS, targetImageSize } from '@ant/computer-use-mcp'
import { logForDebugging } from '../../services/infra/debug.js'
import { errorMessage } from '../../utils/errors.js'
import { execFileNoThrow } from '../shell/execFileNoThrow.js'
import { sleep } from '../../utils/sleep.js'
import { CLI_CU_CAPABILITIES, CLI_HOST_BUNDLE_ID, getTerminalBundleId } from './common.js'
import { drainRunLoop } from './drainRunLoop.js'
import { notifyExpectedEscape } from './escHotkey.js'
import { requireComputerUseInput } from './inputLoader.js'
import { requireComputerUseSwift } from './swiftLoader.js'

// ── 辅助函数 ──────────────────────────────────────────────────────────────────

const SCREENSHOT_JPEG_QUALITY = 0.75

/** 逻辑尺寸 → 物理尺寸 → API 目标尺寸。参见 `targetImageSize` + COORDINATES.md。 */
function computeTargetDims(
  logicalW: number,
  logicalH: number,
  scaleFactor: number,
): [number, number] {
  const physW = Math.round(logicalW * scaleFactor)
  const physH = Math.round(logicalH * scaleFactor)
  return targetImageSize(physW, physH, API_RESIZE_PARAMS)
}

async function readClipboardViaPbpaste(): Promise<string> {
  const { stdout, code } = await execFileNoThrow('pbpaste', [], {
    useCwd: false,
  })
  if (code !== 0) {
    throw new Error(`pbpaste exited with code ${code}`)
  }
  return stdout
}

async function writeClipboardViaPbcopy(text: string): Promise<void> {
  const { code } = await execFileNoThrow('pbcopy', [], {
    input: text,
    useCwd: false,
  })
  if (code !== 0) {
    throw new Error(`pbcopy exited with code ${code}`)
  }
}

type Input = ReturnType<typeof requireComputerUseInput>

/**
 * 仅匹配单元素按键序列 "escape" 或 "esc"（不区分大小写）。
 * 用于对模型合成的 Escape 按键在 CGEventTap 中止逻辑中打孔 —— enigo
 * 接受这两种拼写，所以 tap 也必须同时识别。
 */
function isBareEscape(parts: readonly string[]): boolean {
  if (parts.length !== 1) {
    return false
  }
  const lower = parts[0]!.toLowerCase()
  return lower === 'escape' || lower === 'esc'
}

/**
 * 瞬时移动，然后等待 50ms —— 确保 input→HID→AppKit→NSEvent 往返完成后，调用者
 * 才读取 `NSEvent.mouseLocation` 或派发点击。用于 click、scroll 和 drag-from；
 * `animatedMove` 仅用于 drag-to。中间的动画帧会触发 hover 状态，并且在
 * 分解的 mouseDown/moveMouse 路径上会发出多余的 `.leftMouseDragged` 事件
 * （toolCalls.ts 中 handleScroll 的 mouse_full 解决方案）。
 */
const MOVE_SETTLE_MS = 50

async function moveAndSettle(input: Input, x: number, y: number): Promise<void> {
  await input.moveMouse(x, y, false)
  await sleep(MOVE_SETTLE_MS)
}

/**
 * 以逆序释放 `pressed` 中的按键（最后按下的最先释放）。错误会被吞掉，
 * 以免释放失败掩盖真正的错误。
 *
 * 通过 pop() 逐个消耗，而非快照长度：如果一个被 drainRunLoop 孤立的
 * press lambda 在 finally 调用我们之后才让 input.key() 的 in-flight Promise
 * 解析，那次延迟的 push 仍会在下一次迭代中被释放。orphaned 标志会在其
 * 下一次检查时（而非当前 await 时）停止该 lambda。
 */
async function releasePressed(input: Input, pressed: string[]): Promise<void> {
  let k: string | undefined
  while ((k = pressed.pop()) !== undefined) {
    try {
      await input.key(k, 'release')
    } catch {
      // 吞掉错误 —— 尽力释放。
    }
  }
}

/**
 * 将 `fn()` 包裹在修饰键的 press/release 之间。`pressed` 跟踪哪些 press
 * 实际成功，因此中途 press 抛异常时只会释放已按下的键 —— 不会有卡住的修饰键。
 * finally 同时覆盖 press 阶段和 fn() 的异常。
 *
 * 调用者必须已在 drainRunLoop() 内部 —— key() 派发到主队列，需要泵来解析。
 */
async function withModifiers<T>(input: Input, mods: string[], fn: () => Promise<T>): Promise<T> {
  const pressed: string[] = []
  try {
    for (const m of mods) {
      await input.key(m, 'press')
      pressed.push(m)
    }
    return await fn()
  } finally {
    await releasePressed(input, pressed)
  }
}

/**
 * 移植自 Cowork 的 `typeViaClipboard`。流程：
 *   1. 保存用户当前剪贴板内容。
 *   2. 写入我们的文本。
 *   3. 回读验证 —— 剪贴板写入可能静默失败。如果回读不匹配，
 *      绝不按 Cmd+V（否则会粘贴垃圾内容）。
 *   4. 通过 keys() 执行 Cmd+V。
 *   5. 等待 100ms —— 经过实战验证的阈值，解决粘贴生效 vs
 *      剪贴板恢复之间的竞态。恢复太快会导致目标应用粘贴恢复后的内容。
 *   6. 恢复剪贴板 —— 在 `finally` 中执行，保证步骤 2-5 之间的异常
 *      不会使用户剪贴板保持被覆盖状态。恢复失败会被吞掉。
 */
async function typeViaClipboard(input: Input, text: string): Promise<void> {
  let saved: string | undefined
  try {
    saved = await readClipboardViaPbpaste()
  } catch {
    logForDebugging('[computer-use] pbpaste before paste failed; proceeding without restore')
  }

  try {
    await writeClipboardViaPbcopy(text)
    if ((await readClipboardViaPbpaste()) !== text) {
      throw new Error('Clipboard write did not round-trip.')
    }
    await input.keys(['command', 'v'])
    await sleep(100)
  } finally {
    if (typeof saved === 'string') {
      try {
        await writeClipboardViaPbcopy(saved)
      } catch {
        logForDebugging('[computer-use] clipboard restore after paste failed')
      }
    }
  }
}

/**
 * 移植自 Cowork 的 `animateMouseMovement` + `animatedMove`。使用 ease-out-cubic
 * 曲线以 60fps 运行；移动时长与距离成正比，速率 2000 px/sec，上限 0.5s。当子门控
 * 关闭（或距离不足约 2 帧）时，回退到 `moveAndSettle`。仅在 `drag` 中用于
 * press→to 的运动 —— 目标应用可能只监听 `.leftMouseDragged`（而不仅仅是
 * "按钮按下 + 位置变化"），慢动作给它们时间处理中间位置（滚动条、窗口缩放）。
 */
async function animatedMove(
  input: Input,
  targetX: number,
  targetY: number,
  mouseAnimationEnabled: boolean,
): Promise<void> {
  if (!mouseAnimationEnabled) {
    await moveAndSettle(input, targetX, targetY)
    return
  }
  const start = await input.mouseLocation()
  const deltaX = targetX - start.x
  const deltaY = targetY - start.y
  const distance = Math.hypot(deltaX, deltaY)
  if (distance < 1) {
    return
  }
  const durationSec = Math.min(distance / 2000, 0.5)
  if (durationSec < 0.03) {
    await moveAndSettle(input, targetX, targetY)
    return
  }
  const frameRate = 60
  const frameIntervalMs = 1000 / frameRate
  const totalFrames = Math.floor(durationSec * frameRate)
  for (let frame = 1; frame <= totalFrames; frame++) {
    const t = frame / totalFrames
    const eased = 1 - (1 - t) ** 3
    await input.moveMouse(
      Math.round(start.x + deltaX * eased),
      Math.round(start.y + deltaY * eased),
      false,
    )
    if (frame < totalFrames) {
      await sleep(frameIntervalMs)
    }
  }
  // 最后一帧没有尾部 sleep —— 与调用者的 mouseButton 读取
  // NSEvent.mouseLocation 之间依靠同样的 HID 往返延迟。
  await sleep(MOVE_SETTLE_MS)
}

// ── 工厂函数 ──────────────────────────────────────────────────────────────

export function createCliExecutor(opts: {
  getMouseAnimationEnabled: () => boolean
  getHideBeforeActionEnabled: () => boolean
}): ComputerExecutor {
  if (process.platform !== 'darwin') {
    throw new Error(
      `createCliExecutor called on ${process.platform}. Computer control is macOS-only.`,
    )
  }

  // Swift 在工厂创建时加载一次 —— 每个 executor 方法都需要它。
  // Input 在首次 mouse/keyboard 调用时通过 requireComputerUseInput() 惰性加载
  // —— 其内部有缓存，因此纯截屏流程永远不会拉入 enigo 的 .node。
  const cu = requireComputerUseSwift()

  const { getMouseAnimationEnabled, getHideBeforeActionEnabled } = opts
  const terminalBundleId = getTerminalBundleId()
  const surrogateHost = terminalBundleId ?? CLI_HOST_BUNDLE_ID
  // Swift 0.2.1 的 captureExcluding/captureRegion 虽名为"排除"实际接收的是允许列表
  // （apps#30355 —— 补集在 Swift 端根据运行中的应用计算）。
  // 终端不在用户的授权列表中所以自然被排除，但如果包曾经透传它，
  // 我们在此剔除以确保终端永远不会出现在截屏中。
  const withoutTerminal = (allowed: readonly string[]): string[] =>
    terminalBundleId === null ? [...allowed] : allowed.filter((id) => id !== terminalBundleId)

  logForDebugging(
    terminalBundleId
      ? `[computer-use] terminal ${terminalBundleId} → surrogate host (hide-exempt, activate-skip, screenshot-excluded)`
      : '[computer-use] terminal not detected; falling back to sentinel host',
  )

  return {
    capabilities: {
      ...CLI_CU_CAPABILITIES,
      hostBundleId: CLI_HOST_BUNDLE_ID,
    },

    // ── 操作前序列（隐藏 + 失焦）────────────────────────────

    async prepareForAction(allowlistBundleIds: string[], displayId?: number): Promise<string[]> {
      if (!getHideBeforeActionEnabled()) {
        return []
      }
      // prepareDisplay 不是 @MainActor（使用的是普通 Task{}），但其 .hide() 调用
      // 会触发窗口管理器事件并排入 CFRunLoop。如果没有泵，这些事件会在 Swift 约 1s
      // 的 usleep 期间堆积，并在下一次被泵驱动的调用执行时一次性全部刷出 —— 导致
      // 可见的窗口闪烁。Electron 持续排空 CFRunLoop 所以 Cowork 不会遇到此问题。
      // 最坏情况 100ms + 5×200ms 安全兜底 ≈ 1.1s，远低于 drainRunLoop 的 30s 上限。
      //
      // "即使切换失败也继续执行操作" —— toolCalls.ts 中的前台门控会捕获
      // 任何真正不安全的状态。
      return drainRunLoop(async () => {
        try {
          const result = await cu.apps.prepareDisplay(allowlistBundleIds, surrogateHost, displayId)
          if (result.activated) {
            logForDebugging(`[computer-use] prepareForAction: activated ${result.activated}`)
          }
          return result.hidden
        } catch (err) {
          logForDebugging(
            `[computer-use] prepareForAction failed; continuing to action: ${errorMessage(err)}`,
            { level: 'warn' },
          )
          return []
        }
      })
    },

    async previewHideSet(
      allowlistBundleIds: string[],
      displayId?: number,
    ): Promise<Array<{ bundleId: string; displayName: string }>> {
      return cu.apps.previewHideSet([...allowlistBundleIds, surrogateHost], displayId)
    },

    // ── 显示器 ──────────────────────────────────────────────────────────

    async getDisplaySize(displayId?: number): Promise<DisplayGeometry> {
      return cu.display.getSize(displayId)
    },

    async listDisplays(): Promise<DisplayGeometry[]> {
      return cu.display.listAll()
    },

    async findWindowDisplays(
      bundleIds: string[],
    ): Promise<Array<{ bundleId: string; displayIds: number[] }>> {
      return cu.apps.findWindowDisplays(bundleIds)
    },

    async resolvePrepareCapture(opts: {
      allowedBundleIds: string[]
      preferredDisplayId?: number
      autoResolve: boolean
      doHide?: boolean
    }): Promise<ResolvePrepareCaptureResult> {
      const d = cu.display.getSize(opts.preferredDisplayId)
      const [targetW, targetH] = computeTargetDims(d.width, d.height, d.scaleFactor)
      return drainRunLoop(() =>
        cu.resolvePrepareCapture(
          withoutTerminal(opts.allowedBundleIds),
          surrogateHost,
          SCREENSHOT_JPEG_QUALITY,
          targetW,
          targetH,
          opts.preferredDisplayId,
          opts.autoResolve,
          opts.doHide,
        ),
      )
    },

    /**
     * 预先调整为 `targetImageSize` 的输出尺寸，使 API 转码器的快速返回路径
     * 生效 —— 无需服务端缩放，`scaleCoord` 保持一致性。参见
     * packages/desktop/computer-use-mcp/COORDINATES.md。
     */
    async screenshot(opts: {
      allowedBundleIds: string[]
      displayId?: number
    }): Promise<ScreenshotResult> {
      const d = cu.display.getSize(opts.displayId)
      const [targetW, targetH] = computeTargetDims(d.width, d.height, d.scaleFactor)
      return drainRunLoop(() =>
        cu.screenshot.captureExcluding(
          withoutTerminal(opts.allowedBundleIds),
          SCREENSHOT_JPEG_QUALITY,
          targetW,
          targetH,
          opts.displayId,
        ),
      )
    },

    async zoom(
      regionLogical: { x: number; y: number; w: number; h: number },
      allowedBundleIds: string[],
      displayId?: number,
    ): Promise<{ base64: string; width: number; height: number }> {
      const d = cu.display.getSize(displayId)
      const [outW, outH] = computeTargetDims(regionLogical.w, regionLogical.h, d.scaleFactor)
      return drainRunLoop(() =>
        cu.screenshot.captureRegion(
          withoutTerminal(allowedBundleIds),
          regionLogical.x,
          regionLogical.y,
          regionLogical.w,
          regionLogical.h,
          outW,
          outH,
          SCREENSHOT_JPEG_QUALITY,
          displayId,
        ),
      )
    },

    // ── 键盘 ─────────────────────────────────────────────────────────

    /**
     * xdotool 风格的按键序列，如 "ctrl+shift+a" → 按 '+' 分割并传给
     * keys()。keys() 派发到 DispatchQueue.main —— drainRunLoop 泵送
     * CFRunLoop 使其解析。Rust 的错误路径清理（enigo_wrap.rs）在每次调用时
     * 释放修饰键，因此循环中途抛异常不会卡住任何键。迭代间隔 8ms ——
     * 125Hz USB 轮询节奏。
     */
    async key(keySequence: string, repeat?: number): Promise<void> {
      const input = requireComputerUseInput()
      const parts = keySequence.split('+').filter((p) => p.length > 0)
      // 仅限裸键：CGEventTap 检查 event.flags.isEmpty，所以 ctrl+escape
      // 等组合键会直接通过，不会触发中止。
      const isEsc = isBareEscape(parts)
      const n = repeat ?? 1
      await drainRunLoop(async () => {
        for (let i = 0; i < n; i++) {
          if (i > 0) {
            await sleep(8)
          }
          if (isEsc) {
            notifyExpectedEscape()
          }
          await input.keys(parts)
        }
      })
    },

    async holdKey(keyNames: string[], durationMs: number): Promise<void> {
      const input = requireComputerUseInput()
      // 每次 press/release 都包裹在 drainRunLoop 中；sleep 放在外部，因此
      // durationMs 不受 drainRunLoop 30s 超时限制。`pressed` 跟踪哪些 press
      // 成功落地，这样中途 press 抛异常时仍能释放所有已按下的键。
      //
      // `orphaned` 防范超时-孤立竞态：如果 press 阶段的 drainRunLoop 超时，
      // 而 esc-hotkey 的泵保持运行导致孤立的 lambda 继续向 `pressed` 推入值
      // （在 finally 的 releasePressed 快照长度之后）—— 这会使按键卡住。
      // 该标志在下一次迭代时停止 lambda。
      const pressed: string[] = []
      let orphaned = false
      try {
        await drainRunLoop(async () => {
          for (const k of keyNames) {
            if (orphaned) {
              return
            }
            // 裸 Escape：通知 CGEventTap 不要为模型合成的 press 触发
            // 中止回调。与 key() 逻辑相同。
            if (isBareEscape([k])) {
              notifyExpectedEscape()
            }
            await input.key(k, 'press')
            pressed.push(k)
          }
        })
        await sleep(durationMs)
      } finally {
        orphaned = true
        await drainRunLoop(() => releasePressed(input, pressed))
      }
    },

    async type(text: string, opts: { viaClipboard: boolean }): Promise<void> {
      const input = requireComputerUseInput()
      if (opts.viaClipboard) {
        // 内部的 keys(['command','v']) 需要泵。
        await drainRunLoop(() => typeViaClipboard(input, text))
        return
      }
      // `toolCalls.ts` 处理字素循环 + 8ms 间隔并逐字素调用此方法。
      // typeText 不派发到主队列。
      await input.typeText(text)
    },

    readClipboard: readClipboardViaPbpaste,

    writeClipboard: writeClipboardViaPbcopy,

    // ── 鼠标 ────────────────────────────────────────────────────────────

    async moveMouse(x: number, y: number): Promise<void> {
      await moveAndSettle(requireComputerUseInput(), x, y)
    },

    /**
     * 先移动，再点击。修饰键通过 withModifiers 进行 press/release 包裹 ——
     * 与 Cowork 模式相同。AppKit 根据时间间隔和位置接近度计算
     * NSEvent.clickCount，因此双击/三击无需设置 CGEvent 的 clickState 字段。
     * withModifiers 内部的 key() 需要泵；无修饰键的路径不需要。
     */
    async click(
      x: number,
      y: number,
      button: 'left' | 'right' | 'middle',
      count: 1 | 2 | 3,
      modifiers?: string[],
    ): Promise<void> {
      const input = requireComputerUseInput()
      await moveAndSettle(input, x, y)
      if (modifiers && modifiers.length > 0) {
        await drainRunLoop(() =>
          withModifiers(input, modifiers, () => input.mouseButton(button, 'click', count)),
        )
      } else {
        await input.mouseButton(button, 'click', count)
      }
    },

    async mouseDown(): Promise<void> {
      await requireComputerUseInput().mouseButton('left', 'press')
    },

    async mouseUp(): Promise<void> {
      await requireComputerUseInput().mouseButton('left', 'release')
    },

    async getCursorPosition(): Promise<{ x: number; y: number }> {
      return requireComputerUseInput().mouseLocation()
    },

    /**
     * `from === undefined` → 从当前光标位置开始拖动（训练数据中
     * left_click_drag 省略 start_coordinate 的情况）。内部 `finally`：
     * 即使移动抛异常也必定释放按钮 —— 否则用户的左键会一直处于按住状态，
     * 直到物理点击才能恢复。press 后等待 50ms：enigo 的 move_mouse 读取
     * NSEvent.pressedMouseButtons 来决定发送 .leftMouseDragged 还是
     * .mouseMoved；合成的 leftMouseDown 需要 HID-tap 往返才能在那里可见。
     */
    async drag(
      from: { x: number; y: number } | undefined,
      to: { x: number; y: number },
    ): Promise<void> {
      const input = requireComputerUseInput()
      if (from !== undefined) {
        await moveAndSettle(input, from.x, from.y)
      }
      await input.mouseButton('left', 'press')
      await sleep(MOVE_SETTLE_MS)
      try {
        await animatedMove(input, to.x, to.y, getMouseAnimationEnabled())
      } finally {
        await input.mouseButton('left', 'release')
      }
    },

    /**
     * 先移动，再逐轴滚动。优先垂直方向 —— 这是常用轴；
     * 水平方向失败不应丢失垂直方向的滚动。
     */
    async scroll(x: number, y: number, dx: number, dy: number): Promise<void> {
      const input = requireComputerUseInput()
      await moveAndSettle(input, x, y)
      if (dy !== 0) {
        await input.mouseScroll(dy, 'vertical')
      }
      if (dx !== 0) {
        await input.mouseScroll(dx, 'horizontal')
      }
    },

    // ── 应用管理 ───────────────────────────────────────────────────

    async getFrontmostApp(): Promise<FrontmostApp | null> {
      const info = requireComputerUseInput().getFrontmostAppInfo()
      if (!info?.bundleId) {
        return null
      }
      return { bundleId: info.bundleId, displayName: info.appName }
    },

    async appUnderPoint(
      x: number,
      y: number,
    ): Promise<{ bundleId: string; displayName: string } | null> {
      return cu.apps.appUnderPoint(x, y)
    },

    async listInstalledApps(): Promise<InstalledApp[]> {
      // `ComputerUseInstalledApp` 结构为 `{bundleId, displayName, path}`。
      // `InstalledApp` 额外增加了可选的 `iconDataUrl` —— 此处不填充；
      // 授权对话框通过下面的 getAppIcon() 惰性获取。
      return drainRunLoop(() => cu.apps.listInstalled())
    },

    async getAppIcon(path: string): Promise<string | undefined> {
      return cu.apps.iconDataUrl(path) ?? undefined
    },

    async listRunningApps(): Promise<RunningApp[]> {
      return cu.apps.listRunning()
    },

    async openApp(bundleId: string): Promise<void> {
      await cu.apps.open(bundleId)
    },
  }
}

/**
 * 模块级导出（不在 executor 对象上）—— 在回合结束时由 `stopHooks.ts` / `query.ts`
 * 调用，处于 executor 生命周期之外。调用点以 fire-and-forget 方式使用；
 * 调用者通过 `.catch()` 处理错误。
 */
export async function unhideComputerUseApps(bundleIds: readonly string[]): Promise<void> {
  if (bundleIds.length === 0) {
    return
  }
  const cu = requireComputerUseSwift()
  await cu.apps.unhide([...bundleIds])
}
