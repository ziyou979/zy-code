import * as React from 'react';
import { Text, useTheme } from '../../ink.js';
import { getTheme, type Theme } from '../../utils/theme.js';
import { interpolateColor, parseRGB, toRGBColor } from './utils.js';
type Props = {
  char: string;
  flashOpacity: number;
  messageColor: keyof Theme;
  shimmerColor: keyof Theme;
};
export function FlashingChar({
  char,
  flashOpacity,
  messageColor,
  shimmerColor
}: Props) {
  const [themeName] = useTheme();
  let earlyReturn = Symbol.for("react.early_return_sentinel");
  const theme = getTheme(themeName);
  const baseColorStr = theme[messageColor];
  const shimmerColorStr = theme[shimmerColor];
  const baseRGB = baseColorStr ? parseRGB(baseColorStr) : null;
  const shimmerRGB = shimmerColorStr ? parseRGB(shimmerColorStr) : null;
  if (baseRGB && shimmerRGB) {
    const interpolated = interpolateColor(baseRGB, shimmerRGB, flashOpacity);
    earlyReturn = <Text color={toRGBColor(interpolated)}>{char}</Text> as any;
  }
  if (earlyReturn !== Symbol.for("react.early_return_sentinel")) {
    return earlyReturn;
  }
  const shouldUseShimmer = flashOpacity > 0.5;
  return <Text color={shouldUseShimmer ? shimmerColor : messageColor}>{char}</Text>;
}