/**
 * bridge 轮询循环共享的容量唤醒原语。
 *
 * replBridge.ts 与 bridgeMain.ts 都需要在“达到容量上限”时休眠，但以下任一情况发生时
 * 提前唤醒：(a) 外层循环 signal 因关停而 abort；(b) 容量释放（会话完成或 transport
 * 断开）。本模块封装可变 wake controller 和双 signal 合并逻辑；此前两个轮询循环逐字重复。
 */

export type CapacitySignal = { signal: AbortSignal; cleanup: () => void }

export type CapacityWake = {
  /**
   * 创建 signal；外层循环 signal 或容量唤醒 controller 任一触发时都会 abort。
   * 返回合并后的 signal 与 cleanup 函数，休眠正常结束（未 abort）时用于移除 listener。
   */
  signal(): CapacitySignal
  /**
   * abort 当前因容量已满而进行的休眠，并准备新的 controller，使轮询循环立即检查新任务。
   */
  wake(): void
}

export function createCapacityWake(outerSignal: AbortSignal): CapacityWake {
  let wakeController = new AbortController()

  function wake(): void {
    wakeController.abort()
    wakeController = new AbortController()
  }

  function signal(): CapacitySignal {
    const merged = new AbortController()
    const abort = (): void => merged.abort()
    if (outerSignal.aborted || wakeController.signal.aborted) {
      merged.abort()
      return { signal: merged.signal, cleanup: () => {} }
    }
    outerSignal.addEventListener('abort', abort, { once: true })
    const capSig = wakeController.signal
    capSig.addEventListener('abort', abort, { once: true })
    return {
      signal: merged.signal,
      cleanup: () => {
        outerSignal.removeEventListener('abort', abort)
        capSig.removeEventListener('abort', abort)
      },
    }
  }

  return { signal, wake }
}
