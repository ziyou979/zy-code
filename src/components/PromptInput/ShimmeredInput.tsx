import * as React from 'react'
import { Ansi, Box, Text, useAnimationFrame } from '../../ink.js'
import { segmentTextByHighlights, type TextHighlight } from '../../utils/textHighlighting.js'
import { ShimmerChar } from '../Spinner/ShimmerChar.js'
type Props = {
  text: string
  highlights: TextHighlight[]
}
type LinePart = {
  text: string
  highlight: TextHighlight | undefined
  start: number
}
export function HighlightedInput({ text, highlights }: Props) {
  const segments = segmentTextByHighlights(text, highlights)
  const lines = [[]]
  let pos = 0
  for (const segment of segments) {
    const parts = segment.text.split('\n')
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) {
        lines.push([])
        pos = pos + 1
      }
      const part = parts[i]
      if (part.length > 0) {
        lines[lines.length - 1].push({
          text: part,
          highlight: segment.highlight,
          start: pos,
        })
      }
      pos = pos + part.length
    }
  }
  const hasShimmer = highlights.some((h) => h.shimmerColor)
  let sweepStart = 0
  let cycleLength = 1
  if (hasShimmer) {
    let lo = Infinity
    let hi = -Infinity
    for (const highlight of highlights) {
      if (highlight.shimmerColor) {
        lo = Math.min(lo, highlight.start)
        hi = Math.max(hi, highlight.end)
      }
    }
    sweepStart = lo - 10
    cycleLength = hi - lo + 20
  }
  const {
    lines: lineSegments,
    hasShimmer: hasShimmerEffect,
    sweepStart: sweepStartPosition,
    cycleLength: sweepCycleLength,
  } = {
    lines,
    hasShimmer,
    sweepStart,
    cycleLength,
  }
  const [ref, time] = useAnimationFrame(hasShimmerEffect ? 50 : null)
  const glimmerIndex = hasShimmerEffect
    ? sweepStartPosition + (Math.floor(time / 50) % sweepCycleLength)
    : -100
  const renderedLines = lineSegments.map((lineParts, lineIndex) => (
    <Box key={lineIndex}>
      {lineParts.length === 0 ? (
        <Text> </Text>
      ) : (
        lineParts.map((segmentPart, partIndex) => {
          if (segmentPart.highlight?.shimmerColor && segmentPart.highlight.color) {
            return (
              <Text key={partIndex}>
                {segmentPart.text.split('').map((char, charIndex) => (
                  <ShimmerChar
                    key={charIndex}
                    char={char}
                    index={segmentPart.start + charIndex}
                    glimmerIndex={glimmerIndex}
                    messageColor={segmentPart.highlight.color}
                    shimmerColor={segmentPart.highlight.shimmerColor}
                  />
                ))}
              </Text>
            )
          }
          return (
            <Text
              key={partIndex}
              color={segmentPart.highlight?.color}
              dimColor={segmentPart.highlight?.dimColor}
              inverse={segmentPart.highlight?.inverse}
            >
              <Ansi>{segmentPart.text}</Ansi>
            </Text>
          )
        })
      )}
    </Box>
  ))
  return (
    <Box ref={ref} flexDirection="column">
      {renderedLines}
    </Box>
  )
}
