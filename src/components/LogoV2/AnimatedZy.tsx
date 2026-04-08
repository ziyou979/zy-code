import * as React from 'react';
import { useEffect, useRef, useState } from 'react';
import { Box } from '../../ink.js';
import { getInitialSettings } from '../../utils/settings/settings.js';
import { Zy, type ZyPose } from './Zy.js';
type Frame = {
  pose: ZyPose;
  offset: number;
};

/** Hold a pose for n frames (60ms each). */
function hold(pose: ZyPose, offset: number, frames: number): Frame[] {
  return Array.from({
    length: frames
  }, () => ({
    pose,
    offset
  }));
}

// Offset semantics: marginTop in a fixed-height-5 container. 0 = normal,
// 1 = crouched. Container height stays 5 so the layout never shifts; during
// a crouch (offset=1) the bottom row dips below the container and gets
// clipped — reads as "ducking below the frame" before springing back up.

// Click animation: crouch, then spring up with wing soaring. Twice.
const JUMP_WAVE: readonly Frame[] = [...hold('default', 1, 2),
// crouch
...hold('soaring', 0, 3),
// spring!
...hold('default', 0, 1), ...hold('default', 1, 2),
// crouch again
...hold('soaring', 0, 3),
// spring!
...hold('default', 0, 1)];

// Click animation: tilt right, then left, then back.
const LOOK_AROUND: readonly Frame[] = [...hold('tilt-right', 0, 5), ...hold('tilt-left', 0, 5), ...hold('default', 0, 1)];
const CLICK_ANIMATIONS: readonly (readonly Frame[])[] = [JUMP_WAVE, LOOK_AROUND];
const IDLE: Frame = {
  pose: 'default',
  offset: 0
};
const FRAME_MS = 60;
const incrementFrame = (i: number) => i + 1;
const ZY_HEIGHT = 5;

/**
 * Zy with click-triggered animations (crouch-soar with wing tips up, or
 * tilt-around). Container height is fixed at ZY_HEIGHT — same footprint
 * as a bare `<Zy />` — so the surrounding layout never shifts. During a
 * crouch only the bottom row clips (see comment above). Click only fires when
 * mouse tracking is enabled (i.e. inside `<AlternateScreen>` / fullscreen);
 * elsewhere this renders and behaves identically to plain `<Zy />`.
 */
export function AnimatedZy() {
  const {
    pose,
    bounceOffset,
    onClick
  } = useZyAnimation();
  return (
    <Box height={ZY_HEIGHT} flexDirection="column" onClick={onClick}>
      <Box marginTop={bounceOffset} flexShrink={0}>
        <Zy pose={pose} />
      </Box>
    </Box>
  );
}
function useZyAnimation(): {
  pose: ZyPose;
  bounceOffset: number;
  onClick: () => void;
} {
  // Read once at mount — no useSettings() subscription, since that would
  // re-render on any settings change.
  const [reducedMotion] = useState(() => getInitialSettings().prefersReducedMotion ?? false);
  const [frameIndex, setFrameIndex] = useState(-1);
  const sequenceRef = useRef<readonly Frame[]>(JUMP_WAVE);
  const onClick = () => {
    if (reducedMotion || frameIndex !== -1) return;
    sequenceRef.current = CLICK_ANIMATIONS[Math.floor(Math.random() * CLICK_ANIMATIONS.length)]!;
    setFrameIndex(0);
  };
  useEffect(() => {
    if (frameIndex === -1) return;
    if (frameIndex >= sequenceRef.current.length) {
      setFrameIndex(-1);
      return;
    }
    const timer = setTimeout(setFrameIndex, FRAME_MS, incrementFrame);
    return () => clearTimeout(timer);
  }, [frameIndex]);
  const seq = sequenceRef.current;
  const current = frameIndex >= 0 && frameIndex < seq.length ? seq[frameIndex]! : IDLE;
  return {
    pose: current.pose,
    bounceOffset: current.offset,
    onClick
  };
}
