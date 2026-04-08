import * as React from 'react';
import { Box, Text } from '../../ink.js';
import { env } from '../../utils/env.js';

export type ZyPose =
  | 'default'
  | 'soaring'
  | 'tilt-left'
  | 'tilt-right';

type Props = {
  pose?: ZyPose;
};

// 鸟形状 — 展翅飞翔的鸟
// 5行 × 8列
//
//  视觉:   ▗▄▖    ← 头部
//         ▄█████▄ ← 展开的双翼
//          █████  ← 身体中部
//           ███   ← 身体下部
//            █    ← 尾尖
//
// Colors: 主体 = clawd_body color
//         背景填充 = clawd_background fill
type Segments = {
  r1: string;
  r2: string;
  r3: string;
  r4: string;
  r5: string;
};

const POSES: Record<ZyPose, Segments> = {
  default: {
    r1: '  ▗▄▖    ',
    r2: ' ▄█████▄ ',
    r3: '  █████  ',
    r4: '   ███   ',
    r5: '    █    ',
  },
  soaring: {
    r1: '  ▗▄▖    ',
    r2: '▄███████▄',
    r3: '  █████  ',
    r4: '   ███   ',
    r5: '    █    ',
  },
  'tilt-left': {
    r1: ' ▗▄▖     ',
    r2: '▄█████▄  ',
    r3: ' █████   ',
    r4: '  ███    ',
    r5: '   █     ',
  },
  'tilt-right': {
    r1: '   ▗▄▖   ',
    r2: '  ▄█████▄',
    r3: '   █████ ',
    r4: '    ███  ',
    r5: '     █   ',
  },
};

export function Zy(t0: Props | undefined) {
  let t1;
  if (t0 === undefined) {
    t1 = {};
  } else {
    t1 = t0;
  }
  const { pose: t2 } = t1;
  const pose = t2 === undefined ? 'default' : t2;
  if (env.terminal === 'Apple_Terminal') {
    return <AppleTerminalZy pose={pose} />;
  }
  const p = POSES[pose];
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
  );
}

function AppleTerminalZy(t0: { pose: ZyPose }) {
  const { pose } = t0;
  return (
    <Box flexDirection="column" alignItems="center">
      <Text color="clawd_body">  ▗▄▖    </Text>
      <Text color="clawd_body"> ▄█████▄ </Text>
      <Text color="clawd_body">  █████  </Text>
      <Text color="clawd_body">   ███   </Text>
      <Text color="clawd_body">    █    </Text>
    </Box>
  );
}
