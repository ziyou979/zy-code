import { Box } from '../../ink/index.js'
import { Zy, type ZySize } from './Zy.js'

/**
 * 兼容原有 Logo 调用点的静态容器。Braille 字母 Logo 不再需要点击动画，
 * 容器高度与对应 Braille 点阵行数一致，避免内容溢出到后续布局。
 */
export function AnimatedZy(props: { size?: ZySize } = {}) {
  const size = props.size ?? 'large'
  const height = size === 'large' ? 9 : 6
  return (
    <Box height={height} flexDirection="column">
      <Zy size={size} />
    </Box>
  )
}
