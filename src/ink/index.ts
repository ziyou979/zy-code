import { createElement, type ReactNode } from 'react'
import { ThemeProvider } from '../components/design-system/ThemeProvider.js'
import inkRender, {
  type Instance,
  createRoot as inkCreateRoot,
  type RenderOptions,
  type Root,
} from '../ink/root.js'

export type { Instance, RenderOptions, Root }

// 用 ThemeProvider 包裹所有 CC render 调用，使 ThemedBox/ThemedText 正常工作，
// 无需每个调用点自行挂载。Ink 本身不感知主题。
function withTheme(node: ReactNode): ReactNode {
  return createElement(ThemeProvider, null, node)
}

export async function render(
  node: ReactNode,
  options?: NodeJS.WriteStream | RenderOptions,
): Promise<Instance> {
  return inkRender(withTheme(node), options)
}

export async function createRoot(options?: RenderOptions): Promise<Root> {
  const root = await inkCreateRoot(options)
  return {
    ...root,
    render: (node) => root.render(withTheme(node)),
  }
}

export { color } from '../components/design-system/color.js'
export type { Props as BoxProps } from '../components/design-system/ThemedBox.js'
export { default as Box } from '../components/design-system/ThemedBox.js'
export type { Props as TextProps } from '../components/design-system/ThemedText.js'
export { default as Text } from '../components/design-system/ThemedText.js'
export {
  ThemeProvider,
  usePreviewTheme,
  useTheme,
  useThemeSetting,
} from '../components/design-system/ThemeProvider.js'
export { Ansi } from '../ink/Ansi.js'
export type { Props as AppProps } from '../ink/components/AppContext.js'
export type { Props as BaseBoxProps } from '../ink/components/Box.js'
export { default as BaseBox } from '../ink/components/Box.js'
export type {
  ButtonState,
  Props as ButtonProps,
} from '../ink/components/Button.js'
export { default as Button } from '../ink/components/Button.js'
export type { Props as LinkProps } from '../ink/components/Link.js'
export { default as Link } from '../ink/components/Link.js'
export type { Props as NewlineProps } from '../ink/components/Newline.js'
export { default as Newline } from '../ink/components/Newline.js'
export { NoSelect } from '../ink/components/NoSelect.js'
export { RawAnsi } from '../ink/components/RawAnsi.js'
export { default as Spacer } from '../ink/components/Spacer.js'
export type { Props as StdinProps } from '../ink/components/StdinContext.js'
export type { Props as BaseTextProps } from '../ink/components/Text.js'
export { default as BaseText } from '../ink/components/Text.js'
export type { DOMElement } from '../ink/dom.js'
export { ClickEvent } from '../ink/events/clickEvent.js'
export { EventEmitter } from '../ink/events/emitter.js'
export { Event } from '../ink/events/event.js'
export type { Key } from '../ink/events/inputEvent.js'
export { InputEvent } from '../ink/events/inputEvent.js'
export type { TerminalFocusEventType } from '../ink/events/terminalFocusEvent.js'
export { TerminalFocusEvent } from '../ink/events/terminalFocusEvent.js'
export { FocusManager } from '../ink/focus.js'
export type { FlickerReason } from '../ink/frame.js'
export { useAnimationFrame } from '../ink/hooks/useAnimationFrame.js'
export { default as useApp } from '../ink/hooks/useApp.js'
export { default as useInput } from '../ink/hooks/useInput.js'
export { useAnimationTimer, useInterval } from '../ink/hooks/useInterval.js'
export { useSelection } from '../ink/hooks/useSelection.js'
export { default as useStdin } from '../ink/hooks/useStdin.js'
export { useTabStatus } from '../ink/hooks/useTabStatus.js'
export { useTerminalFocus } from '../ink/hooks/useTerminalFocus.js'
export { useTerminalTitle } from '../ink/hooks/useTerminalTitle.js'
export { useTerminalViewport } from '../ink/hooks/useTerminalViewport.js'
export { default as measureElement } from '../ink/measureElement.js'
export { supportsTabStatus } from '../ink/termio/osc.js'
export { default as wrapText } from '../ink/wrapText.js'
