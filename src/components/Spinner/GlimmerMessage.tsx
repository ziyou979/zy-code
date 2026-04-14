import * as React from 'react';
import { stringWidth } from '../../ink/stringWidth.js';
import { Text, useTheme } from '../../ink.js';
import { getGraphemeSegmenter } from '../../utils/intl.js';
import { getTheme, type Theme } from '../../utils/theme.js';
import type { SpinnerMode } from './types.js';
import { interpolateColor, parseRGB, toRGBColor } from './utils.js';
type Props = {
  message: string;
  mode: SpinnerMode;
  messageColor: keyof Theme;
  glimmerIndex: number;
  flashOpacity: number;
  shimmerColor: keyof Theme;
  stalledIntensity?: number;
};
const ERROR_RED = {
  r: 171,
  g: 43,
  b: 63
};
export function GlimmerMessage({
  message,
  mode,
  messageColor,
  glimmerIndex,
  flashOpacity,
  shimmerColor,
  stalledIntensity = 0
}: Props) {
  const [themeName] = useTheme();
  let earlyReturn;
  earlyReturn = Symbol.for("react.early_return_sentinel");
  const theme = getTheme(themeName);
  const segs = [];
  for (const {
    segment
  } of getGraphemeSegmenter().segment(message)) {
    segs.push({
      segment,
      width: stringWidth(segment)
    });
  }
  const stringWidthResult = stringWidth(message);
  let segments: typeof segs;
  let messageWidth: number;
  ({
    segments,
    messageWidth
  } = {
    segments: segs,
    messageWidth: stringWidthResult
  });
  if (!message) {
    earlyReturn = null;
  } else if (stalledIntensity > 0) {
    const baseColorStr = theme[messageColor];
    const baseRGB = baseColorStr ? parseRGB(baseColorStr) : null;
    if (baseRGB) {
      const interpolated = interpolateColor(baseRGB, ERROR_RED, stalledIntensity);
      const color = toRGBColor(interpolated);
      earlyReturn = <><Text color={color}>{message}</Text>{<Text color={color}> </Text>}</>;
    } else {
      const color_0 = stalledIntensity > 0.5 ? "error" : messageColor;
      earlyReturn = <>{<Text color={color_0}>{message}</Text>}{<Text color={color_0}> </Text>}</>;
    }
  } else if (mode === "tool-use") {
    const baseColorStr_0 = theme[messageColor];
    const shimmerColorStr = theme[shimmerColor];
    const baseRGB_0 = baseColorStr_0 ? parseRGB(baseColorStr_0) : null;
    const shimmerRGB = shimmerColorStr ? parseRGB(shimmerColorStr) : null;
    if (baseRGB_0 && shimmerRGB) {
      const interpolated_0 = interpolateColor(baseRGB_0, shimmerRGB, flashOpacity);
      earlyReturn = <>{<Text color={toRGBColor(interpolated_0)}>{message}</Text>}{<Text color={messageColor}> </Text>}</>;
    } else {
      const color_1 = flashOpacity > 0.5 ? shimmerColor : messageColor;
      earlyReturn = <>{<Text color={color_1}>{message}</Text>}{<Text color={messageColor}> </Text>}</>;
    }
  }
  if (earlyReturn !== Symbol.for("react.early_return_sentinel")) {
    return earlyReturn;
  }
  const shimmerStart = glimmerIndex - 1;
  const shimmerEnd = glimmerIndex + 1;
  if (shimmerStart >= messageWidth || shimmerEnd < 0) {
    return <>{<Text color={messageColor}>{message}</Text>}{<Text color={messageColor}> </Text>}</>;
  }
  const clampedStart = Math.max(0, shimmerStart);
  let colPos = 0;
  let before = "";
  let shim = "";
  let after = "";
  for (const {
    segment: segment_0,
    width
  } of segments) {
    if (colPos + width <= clampedStart) {
      before = before + segment_0;
    } else {
      if (colPos > shimmerEnd) {
        after = after + segment_0;
      } else {
        shim = shim + segment_0;
      }
    }
    colPos = colPos + width;
  }
  return <>{before && <Text color={messageColor}>{before}</Text>}{<Text color={shimmerColor}>{shim}</Text>}{after && <Text color={messageColor}>{after}</Text>}{<Text color={messageColor}> </Text>}</>;
}