import React, { type PropsWithChildren, useContext, useInsertionEffect } from 'react';
import instances from '../instances.js';
import { DISABLE_MOUSE_TRACKING, ENABLE_MOUSE_TRACKING, ENTER_ALT_SCREEN, EXIT_ALT_SCREEN } from '../termio/dec.js';
import { TerminalWriteContext } from '../useTerminalNotification.js';
import Box from './Box.js';
import { TerminalSizeContext } from './TerminalSizeContext.js';
type Props = PropsWithChildren<{
  /** 启用 SGR 鼠标追踪（滚轮 + 点击/拖拽）。默认为 true。 */
  mouseTracking?: boolean;
}>;

/**
 * 在终端的备用屏幕缓冲区中渲染子内容，受视口高度限制。挂载期间：
 *
 * - 进入备用屏幕（DEC 1049），清屏，将光标归位
 * - 将自身高度限制为终端行数，因此溢出必须通过 `overflow: scroll` / flexbox
 *   处理（无原生滚动回退）
 * - 可选启用 SGR 鼠标追踪（滚轮 + 点击/拖拽）— 事件作为 `ParsedKey` 表面化
 *   （滚轮）并更新 Ink 实例的选择状态（点击/拖拽）
 *
 * 卸载时禁用鼠标追踪并退出备用屏幕，恢复主屏幕内容。适用于 ctrl-o 转录
 * 覆盖层等临时全屏视图——主屏幕内容会被保留。
 *
 * 通过 `setAltScreenActive()` 通知 Ink 实例，使渲染器保持光标在视口内
 * （防止光标恢复时的换行符滚动内容），并且如果组件自身的卸载未执行，
 * signal-exit 清理可以退出备用屏幕。
 */
export function AlternateScreen({
  children,
  mouseTracking = true
}: Props) {
  const size = useContext(TerminalSizeContext);
  const writeRaw = useContext(TerminalWriteContext);
  useInsertionEffect(() => {
    const ink = instances.get(process.stdout);
    if (!writeRaw) {
      return;
    }
    writeRaw(ENTER_ALT_SCREEN + "\x1B[2J\x1B[H" + (mouseTracking ? ENABLE_MOUSE_TRACKING : ""));
    ink?.setAltScreenActive(true, mouseTracking);
    return () => {
      ink?.setAltScreenActive(false);
      ink?.clearTextSelection();
      writeRaw((mouseTracking ? DISABLE_MOUSE_TRACKING : "") + EXIT_ALT_SCREEN);
    };
  }, [writeRaw, mouseTracking]);
  const terminalRows = size?.rows ?? 24;
  return <Box flexDirection="column" height={terminalRows} width="100%" flexShrink={0}>{children}</Box>;
}
