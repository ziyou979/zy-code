import { type AppState, useAppState } from '../state/AppState.js'

/**
 * AppState 中存储的 Settings 类型（DeepImmutable 包装）。
 * 当你需要注解持有 useSettings() 返回的 settings 的变量时，使用此类型。
 */
export type ReadonlySettings = AppState['settings']

/**
 * React hook，用于从 AppState 中读取当前 settings。
 * 当 settingsChangeDetector 检测到磁盘上的文件变更时，settings 会自动更新。
 *
 * 在 React 组件中，请使用此 hook 替代 getInitialSettings() 以获得响应式更新。
 */
export function useSettings(): ReadonlySettings {
  return useAppState((s) => s.settings)
}
