import React, { type Ref, useEffect, useRef, useState } from 'react';
import type { Except } from 'type-fest';
import type { DOMElement } from '../dom.js';
import type { Styles } from '../styles.js';
import Box from './Box.js';
type ButtonState = {
  focused: boolean;
  hovered: boolean;
  active: boolean;
};
export type Props = Except<Styles, 'textWrap'> & {
  ref?: Ref<DOMElement>;
  /**
   * Called when the button is activated via Enter, Space, or click.
   */
  onAction: () => void;
  /**
   * Tab order index. Defaults to 0 (in tab order).
   * Set to -1 for programmatically focusable only.
   */
  tabIndex?: number;
  /**
   * Focus this button when it mounts.
   */
  autoFocus?: boolean;
  /**
   * Render prop receiving the interactive state. Use this to
   * style children based on focus/hover/active — Button itself
   * is intentionally unstyled.
   *
   * If not provided, children render as-is (no state-dependent styling).
   */
  children: ((state: ButtonState) => React.ReactNode) | React.ReactNode;
};
function Button({
  onAction,
  tabIndex = 0,
  autoFocus,
  children,
  ref,
  ...style
}: Props) {
  const [isFocused, setIsFocused] = useState(false);
  const [isHovered, setIsHovered] = useState(false);
  const [isActive, setIsActive] = useState(false);
  const activeTimer = useRef(null);
  useEffect(() => () => {
    if (activeTimer.current) {
      clearTimeout(activeTimer.current);
    }
  }, []);
  const handleKeyDown = e => {
    if (e.key === "return" || e.key === " ") {
      e.preventDefault();
      setIsActive(true);
      onAction();
      if (activeTimer.current) {
        clearTimeout(activeTimer.current);
      }
      activeTimer.current = setTimeout(setter => setter(false), 100, setIsActive);
    }
  };
  const handleClick = _e => {
    onAction();
  };
  const handleFocus = _e_0 => setIsFocused(true);
  const handleBlur = _e_1 => setIsFocused(false);
  const handleMouseEnter = () => setIsHovered(true);
  const handleMouseLeave = () => setIsHovered(false);
  const state = {
    focused: isFocused,
    hovered: isHovered,
    active: isActive
  };
  const content = typeof children === "function" ? children(state) : children;
  return <Box ref={ref} tabIndex={tabIndex} autoFocus={autoFocus} onKeyDown={handleKeyDown} onClick={handleClick} onFocus={handleFocus} onBlur={handleBlur} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} {...style}>{content}</Box>;
}
export default Button;
export type { ButtonState };
