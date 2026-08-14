import { createContext } from 'react'

export type Props = {
  /**
   * 退出（卸载）整个 Ink 应用。
   */
  readonly exit: (error?: Error) => void
}

/**
 * `AppContext` 是一个 React context，提供手动退出（卸载）应用的方法。
 */
// eslint-disable-next-line @typescript-eslint/naming-convention
const AppContext = createContext<Props>({
  exit() {},
})

// eslint-disable-next-line custom-rules/no-top-level-side-effects
AppContext.displayName = 'InternalAppContext'

export default AppContext
