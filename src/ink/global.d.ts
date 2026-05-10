// Global type declarations for ink components

import type { Props as BoxProps } from './components/Box.js'

declare global {
  namespace JSX {
    interface IntrinsicElements {
      'ink-box': BoxProps
    }
  }
}
