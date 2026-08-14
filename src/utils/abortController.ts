import { setMaxListeners } from 'node:events'

/**
 * 常规操作的默认最大监听器数量。
 */
const DEFAULT_MAX_LISTENERS = 50

/**
 * 创建设置了合理事件监听器上限的 AbortController。
 * 避免 abort signal 挂载多个监听器时出现 MaxListenersExceededWarning。
 *
 * @param maxListeners - Maximum number of listeners (default: 50)
 * @returns AbortController with configured listener limit
 */
export function createAbortController(
  maxListeners: number = DEFAULT_MAX_LISTENERS,
): AbortController {
  const controller = new AbortController()
  setMaxListeners(maxListeners, controller.signal)
  return controller
}

/**
 * 将父 signal 的 abort 传播给弱引用的子 controller。
 * 父子双方均通过弱引用持有，两个方向都不会形成阻止 GC 的强引用。
 * 使用模块级函数，避免每次调用都分配闭包。
 */
function propagateAbort(this: WeakRef<AbortController>, weakChild: WeakRef<AbortController>): void {
  const parent = this.deref()
  weakChild.deref()?.abort(parent?.signal.reason)
}

/**
 * 从弱引用的父 signal 中移除 abort handler。
 * 父 signal 和 handler 均为弱引用；任一对象已被 GC，或父 signal 已 abort
 *（{once: true}）时，此操作不产生效果。使用模块级函数避免每次调用分配闭包。
 */
function removeAbortHandler(
  this: WeakRef<AbortController>,
  weakHandler: WeakRef<(...args: unknown[]) => void>,
): void {
  const parent = this.deref()
  const handler = weakHandler.deref()
  if (parent && handler) {
    parent.signal.removeEventListener('abort', handler)
  }
}

/**
 * 创建随父级 abort 的子 AbortController；子级 abort 不会影响父级。
 *
 * 内存安全：使用 WeakRef，避免父级保留已弃用的子级。子级即使未 abort 就被丢弃，
 * 仍可被 GC；子级确实 abort 时会移除父级监听器，防止无效 handler 累积。
 *
 * @param parent - The parent AbortController
 * @param maxListeners - Maximum number of listeners (default: 50)
 * @returns Child AbortController
 */
export function createChildAbortController(
  parent: AbortController,
  maxListeners?: number,
): AbortController {
  const child = createAbortController(maxListeners)

  // 快速路径：父级已 abort，无需设置监听器
  if (parent.signal.aborted) {
    child.abort(parent.signal.reason)
    return child
  }

  // WeakRef 防止父级维持已弃用子级的存活。即使子级未 abort 就失去全部强引用，
  // 仍可被 GC；父级最终只会持有失效的 WeakRef。
  const weakChild = new WeakRef(child)
  const weakParent = new WeakRef(parent)
  const handler = propagateAbort.bind(weakParent, weakChild)

  parent.signal.addEventListener('abort', handler, { once: true })

  // 自动清理：子级因任意来源 abort 时移除父级监听器。父级和 handler 均为弱引用；
  // 任一对象已被 GC，或父级已 abort（{once: true}）时，清理不产生效果且没有风险。
  child.signal.addEventListener(
    'abort',
    removeAbortHandler.bind(weakParent, new WeakRef(handler)),
    { once: true },
  )

  return child
}

/**
 * 创建组合 AbortSignal：输入 signal、可选的第二个 signal abort，或可选超时到期时，
 * 组合 signal 随之 abort。返回 signal 以及用于移除事件监听器和内部定时器的清理函数。
 *
 * 应使用 `timeoutMs`，不要把 `AbortSignal.timeout(ms)` 作为 signal 传入。
 * Bun 会延迟终结 `AbortSignal.timeout` 定时器，使其在触发前持续占用 native 内存
 *（实测每次调用约 2.4KB，并在整个超时期间保留）。此实现采用 `setTimeout` 与
 * `clearTimeout`，清理时可立即释放定时器。
 */
export function createCombinedAbortSignal(
  signal: AbortSignal | undefined,
  opts?: { signalB?: AbortSignal; timeoutMs?: number },
): { signal: AbortSignal; cleanup: () => void } {
  const { signalB, timeoutMs } = opts ?? {}
  const combined = createAbortController()

  if (signal?.aborted || signalB?.aborted) {
    combined.abort()
    return { signal: combined.signal, cleanup: () => {} }
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  const abortCombined = () => {
    if (timer !== undefined) {
      clearTimeout(timer)
    }
    combined.abort()
  }

  if (timeoutMs !== undefined) {
    timer = setTimeout(abortCombined, timeoutMs)
    timer.unref?.()
  }
  signal?.addEventListener('abort', abortCombined)
  signalB?.addEventListener('abort', abortCombined)

  const cleanup = () => {
    if (timer !== undefined) {
      clearTimeout(timer)
    }
    signal?.removeEventListener('abort', abortCombined)
    signalB?.removeEventListener('abort', abortCombined)
  }

  return { signal: combined.signal, cleanup }
}
