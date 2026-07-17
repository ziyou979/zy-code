import { Box, Text } from '../../ink/index.js'
import { env } from '../../services/environment/env.js'

export type ZyPose = 'default' | 'soaring' | 'tilt-left' | 'tilt-right'

type Props = {
  pose?: ZyPose
}

// 水母形状 — 海绵宝宝风格的可爱水母 🪼
// 5行 × 13列，严格左右对称（中心在索引6）
//
//  视觉:   ▄▀▀▀▀▀▀▀▄    ← 圆顶
//         █  ●   ●  █   ← 身体 + 眼睛
//         █  ▀▀▀  █     ← 嘴巴
//         ▀▄     ▄▀     ← 两侧弯须
//          ▀▄▀▀▀▄▀      ← 底部触须
//
// Colors: 主体 = clawd_body color
//         背景填充 = clawd_background fill
type Segments = {
  r1: string
  r2: string
  r3: string
  r4: string
  r5: string
}

const POSES: Record<ZyPose, Segments> = {
  default: {
    r1: '  ▄▀▀▀▀▀▀▀▄  ',
    r2: ' █  ●   ●  █ ',
    r3: '  █  ▀▀▀  █  ',
    r4: '  ▀▄     ▄▀  ',
    r5: '   ▀▄▀▀▀▄▀   ',
  },
  soaring: {
    r1: ' ▄▀▀▀▀▀▀▀▀▀▄ ',
    r2: '█  ●     ●  █',
    r3: '█    ▀▀▀    █',
    r4: '▀▄         ▄▀',
    r5: '  ▀▄▀▀▀▀▀▄▀  ',
  },
  'tilt-left': {
    r1: ' ▄▀▀▀▀▀▀▀▄   ',
    r2: '█  ●   ●  █  ',
    r3: ' █  ▀▀▀  █   ',
    r4: ' ▀▄     ▄▀   ',
    r5: '  ▀▄▀▀▀▄▀    ',
  },
  'tilt-right': {
    r1: '   ▄▀▀▀▀▀▀▀▄ ',
    r2: '  █  ●   ●  █',
    r3: '   █  ▀▀▀  █ ',
    r4: '   ▀▄     ▄▀ ',
    r5: '    ▀▄▀▀▀▄▀  ',
  },
}

export function Zy(props: Props | undefined) {
  let config
  if (props === undefined) {
    config = {}
  } else {
    config = props
  }
  const { pose: poseProp } = config
  const pose = poseProp === undefined ? 'default' : poseProp
  if (env.terminal === 'Apple_Terminal') {
    return <AppleTerminalZy pose={pose} />
  }
  const p = POSES[pose]
  return (
    <Box flexDirection="column">
      <Text>
        <Text color="clawd_body">{p.r1}</Text>
      </Text>
      <Text>
        <Text color="clawd_body">{p.r2}</Text>
      </Text>
      <Text>
        <Text color="clawd_body">{p.r3}</Text>
      </Text>
      <Text>
        <Text color="clawd_body">{p.r4}</Text>
      </Text>
      <Text>
        <Text color="clawd_body">{p.r5}</Text>
      </Text>
    </Box>
  )
}

function AppleTerminalZy(props: { pose: ZyPose }) {
  const { pose } = props
  const p = POSES[pose]
  return (
    <Box flexDirection="column" alignItems="center">
      <Text color="clawd_body">{p.r1}</Text>
      <Text color="clawd_body">{p.r2}</Text>
      <Text color="clawd_body">{p.r3}</Text>
      <Text color="clawd_body">{p.r4}</Text>
      <Text color="clawd_body">{p.r5}</Text>
    </Box>
  )
}
