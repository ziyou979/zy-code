// Ink 组件的全局类型声明

import type { Props as BoxProps } from './components/Box.js'

declare global {
  namespace JSX {
    interface IntrinsicElements {
      'ink-box': BoxProps
    }
  }
}
