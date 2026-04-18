import React from 'react';
type Props = {
  /**
   * 预渲染的 ANSI 行。每个元素必须恰好是一个终端行
   * （已由生产者按 `width` 换行），ANSI 转义码内联。
   */
  lines: string[];
  /** 生产者换行的列宽。作为固定叶子宽度传给 Yoga。 */
  width: number;
};

/**
 * 绕过 <Ansi> → React 树 → Yoga → 压缩 → 重新序列化的循环，
 * 直接输出终端就绪的内容。
 *
 * 当外部渲染器（如 ColorDiff NAPI 模块）已生成 ANSI 转义且按宽度
 * 换行的输出时使用此组件。普通 <Ansi> 挂载会将该输出重新解析为每个
 * 样式段的 React <Text>，将每段布局为 Yoga flex 子节点，然后遍历
 * 树重新发出相同的转义码。对于充满语法高亮差异的长转录，这个往返
 * 是渲染的主要开销。
 *
 * 此组件发射单个 Yoga 叶子，具有常数时间的 measure 函数
 * （宽度 × lines.length），并将拼接的字符串直接交给 output.write()，
 * 后者已按 '\n' 分割并将 ANSI 解析到屏幕缓冲区。
 */
export function RawAnsi({
  lines,
  width
}: Props) {
  if (lines.length === 0) {
    return null;
  }
  const joinedText = lines.join("\n");
  // @ts-ignore
  return <ink-raw-ansi rawText={joinedText} rawWidth={width} rawHeight={lines.length} />;
}
