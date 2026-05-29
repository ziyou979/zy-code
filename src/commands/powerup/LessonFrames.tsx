import { useEffect, useState } from 'react'
import { tSync } from '../../i18n/index.js'
import { Box, Text } from '../../ink.js'
import { DEFAULT_FRAME_MS, type LessonFrame } from './frames.js'

type Props = {
  frames: LessonFrame[]
}

/** 定宽边框 —— 不随帧内容长度变化，避免每次切帧抖动 */
const DEMO_BOX_WIDTH = 64

/**
 * 课程详情视图里的循环动画 —— 模拟用户输入 + 响应。
 *
 * 单帧时不启动定时器（静态展示）；多帧时按帧的 durationMs（缺省 2400ms）切换，
 * 卸载会清理待处理 timer。父级用 key=lesson.id 切换课程，因此本组件无需手动复位 index。
 */
export function LessonFrames({ frames }: Props) {
  const [index, setIndex] = useState(0)

  useEffect(() => {
    if (frames.length <= 1) {
      return
    }
    const current = frames[index] ?? frames[0]!
    const dur = current.durationMs ?? DEFAULT_FRAME_MS
    const timer = setTimeout(() => {
      setIndex((prev) => (prev + 1) % frames.length)
    }, dur)
    return () => clearTimeout(timer)
  }, [frames, index])

  if (frames.length === 0) {
    return null
  }

  const current = frames[index] ?? frames[0]!
  const positionLabel = frames.length > 1 ? ` ${index + 1}/${frames.length}` : ''

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="subtle"
      paddingX={1}
      width={DEMO_BOX_WIDTH}
    >
      <Text color="subtle">
        ▶ {tSync('powerup.demoLabel')}
        {positionLabel}
      </Text>
      <Box marginTop={1} flexDirection="row">
        <Text color="zy">{'› '}</Text>
        <Text>{current.prompt}</Text>
      </Box>
      <Box flexDirection="row">
        <Text color="subtle">{'  '}</Text>
        <Text color="subtle">{current.response}</Text>
      </Box>
    </Box>
  )
}
