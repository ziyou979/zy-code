/**
 * 跟踪 Overlay，用于协调 Escape 键的处理。
 *
 * 这用于解决 Overlay（例如带 onCancel 的 Select）打开时 Escape 键的归属问题。
 * CancelRequestHandler 需要知道当前是否存在活跃 Overlay，以免用户只想关闭 Overlay
 * 时误取消请求。
 *
 * 用法：
 * 1. 在任意 Overlay 组件中调用 useRegisterOverlay() 自动注册
 * 2. 调用 useIsOverlayActive() 检查当前是否存在活跃 Overlay
 *
 * Hook 会在挂载时自动注册、卸载时自动注销，无需手动清理或管理状态。
 */
import { useContext, useEffect, useLayoutEffect } from 'react'
import instances from '../ink/instances.js'
import { AppStoreContext, useAppState } from '../state/AppState.js'

// Non-modal overlays that shouldn't disable TextInput focus
const NON_MODAL_OVERLAYS = new Set(['autocomplete'])

/**
 * 将组件注册为活跃 Overlay 的 Hook。
 * 挂载时自动注册，卸载时自动注销。
 *
 * @param id Overlay 的唯一标识，例如 'select'、'multi-select'
 * @param enabled 是否注册，默认为 true。可根据组件属性有条件注册，例如仅在提供 onCancel 时注册
 *
 * @example
 * // 根据是否支持取消操作决定是否注册
 * function useSelectInput({ state }) {
 *   useRegisterOverlay('select', !!state.onCancel)
 *   // ...
 * }
 */
export function useRegisterOverlay(id: string, enabledParam?: boolean) {
  const enabled = enabledParam === undefined ? true : enabledParam
  const store = useContext(AppStoreContext)
  const setAppState = store?.setState
  useEffect(() => {
    if (!enabled || !setAppState) {
      return
    }
    setAppState((prev) => {
      if (prev.activeOverlays.has(id)) {
        return prev
      }
      const next = new Set(prev.activeOverlays)
      next.add(id)
      return {
        ...prev,
        activeOverlays: next,
      }
    })
    return () => {
      setAppState((prevState) => {
        if (!prevState.activeOverlays.has(id)) {
          return prevState
        }
        const nextOverlays = new Set(prevState.activeOverlays)
        nextOverlays.delete(id)
        return {
          ...prevState,
          activeOverlays: nextOverlays,
        }
      })
    }
  }, [id, enabled, setAppState])
  useLayoutEffect(() => {
    if (!enabled) {
      return
    }
    return () => instances.get(process.stdout)?.invalidatePrevFrame()
  }, [enabled])
}

/**
 * 检查当前是否存在活跃 Overlay 的 Hook。
 * 此 Hook 具有响应性，Overlay 状态变化时组件会重新渲染。
 *
 * @returns 存在活跃 Overlay 时返回 true
 *
 * @example
 * function CancelRequestHandler() {
 *   const isOverlayActive = useIsOverlayActive()
 *   const isActive = !isOverlayActive && canCancelRunningTask
 *   useKeybinding('chat:cancel', handleCancel, { isActive })
 * }
 */

export function useIsOverlayActive() {
  return useAppState((s) => s.activeOverlays.size > 0)
}

/**
 * 检查当前是否存在活跃模态 Overlay 的 Hook。
 * 模态 Overlay（如 Select 对话框）会捕获全部输入；非模态 Overlay（如自动补全）
 * 不会禁用 TextInput 焦点。
 *
 * @returns 存在活跃模态 Overlay 时返回 true
 *
 * @example
 * // 用于控制 TextInput 焦点，允许在自动补全期间继续输入
 * focus: !isSearchingHistory && !isModalOverlayActive
 */

export function useIsModalOverlayActive() {
  return useAppState((s) => {
    for (const id of s.activeOverlays) {
      if (!NON_MODAL_OVERLAYS.has(id)) {
        return true
      }
    }
    return false
  })
}
