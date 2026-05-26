// 滚动排出暂停 —— 后台间隔检查此标志，避免与滚动帧竞争事件循环。
// 完全独立于 STATE：纯模块本地热路径标志，自清除（防抖定时器到期）。
// 不参与 resetStateForTests，因为定时器到期后自然清零，测试无需手动重置。

let scrollDraining = false
let scrollDrainTimer: ReturnType<typeof setTimeout> | undefined
const SCROLL_DRAIN_IDLE_MS = 150

/** 标记滚动事件刚刚发生。后台间隔通过
 *  getIsScrollDraining() 门控，在防抖清除前跳过工作。 */
export function markScrollActivity(): void {
  scrollDraining = true
  if (scrollDrainTimer) {
    clearTimeout(scrollDrainTimer)
  }
  scrollDrainTimer = setTimeout(() => {
    scrollDraining = false
    scrollDrainTimer = undefined
  }, SCROLL_DRAIN_IDLE_MS)
  scrollDrainTimer.unref?.()
}

/** 滚动正在排出时为 true（最后一次事件后 150ms 内）。
 *  间隔在此设置时应提前返回 — 工作会在滚动平息后的
 *  下一次 tick 继续。 */
export function getIsScrollDraining(): boolean {
  return scrollDraining
}

/** 在可能与滚动同时发生的昂贵一次性工作
 *  （网络、子进程）前等待此函数。如果未滚动则立即解析；
 *  否则以空闲间隔轮询直到标志清除。 */
export async function waitForScrollIdle(): Promise<void> {
  while (scrollDraining) {
    // bootstrap-isolation 禁止从 src/utils/ 导入 sleep()
    // eslint-disable-next-line no-restricted-syntax
    await new Promise((r) => setTimeout(r, SCROLL_DRAIN_IDLE_MS).unref?.())
  }
}
