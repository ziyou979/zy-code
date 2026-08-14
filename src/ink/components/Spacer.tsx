import Box from './Box.js'

/**
 * 可沿容器布局主轴扩展的弹性空白。
 * 可用于快速填满元素之间的所有可用空间。
 */
export default function Spacer() {
  return <Box flexGrow={1} />
}
