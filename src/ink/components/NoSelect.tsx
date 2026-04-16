import React from 'react';
import Box, { type Props as BoxProps } from './Box.js';
type Props = Omit<BoxProps, 'noSelect'> & {
  /**
   * 将排除区域从第 0 列扩展到此 box 的右边缘，
   * 覆盖此 box 占据的每一行。用于在更宽的缩进容器内
   * 渲染的边距（如工具消息行中的差异）：
   * 没有此选项时，多行拖拽会在前缀下方的行上拾取容器的
   * 前导缩进。
   *
   * @default false
   */
  fromLeftEdge?: boolean;
};

/**
 * 在全屏文本选择中将其内容标记为不可选择。
 * 此 box 内的单元格会被选择高亮和复制文本跳过——边距
 * 在用户拖拽时保持视觉不变，从而清晰表明哪些内容会被复制。
 *
 * 用于隔离边距（行号、差异 +/- 符号、列表项目符号），
 * 使在渲染代码上点击拖拽时产生干净的可粘贴内容：
 *
 *   <Box flexDirection="row">
 *     <NoSelect fromLeftEdge><Text dimColor> 42 +</Text></NoSelect>
 *     <Text>const x = 1</Text>
 *   </Box>
 *
 * 仅影响备用屏幕文本选择（带鼠标追踪的 <AlternateScreen>）。
 * 在主屏幕滚动回退渲染中无作用，此时使用终端的原生选择。
 */
export function NoSelect({
  children,
  fromLeftEdge,
  ...boxProps
}: Props) {
  return <Box {...boxProps} noSelect={fromLeftEdge ? "from-left-edge" : true}>{children}</Box>;
}
