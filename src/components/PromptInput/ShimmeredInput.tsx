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
    for (const h_0 of highlights) {
      if (h_0.shimmerColor) {
        lo = Math.min(lo, h_0.start)
        hi = Math.max(hi, h_0.end)
      }
    }
    sweepStart = lo - 10
    cycleLength = hi - lo + 20
  }
  const {
    lines: lines_0,
    hasShimmer: hasShimmer_0,
    sweepStart: sweepStart_0,
    cycleLength: cycleLength_0,
  } = {
    lines,
    hasShimmer,
    sweepStart,
    cycleLength,
  }
  const [ref, time] = useAnimationFrame(hasShimmer_0 ? 50 : null)
  const glimmerIndex = hasShimmer_0 ? sweepStart_0 + (Math.floor(time / 50) % cycleLength_0) : -100
  const t3 = lines_0.map((lineParts, lineIndex) => (
    <Box key={lineIndex}>
      {lineParts.length === 0 ? (
        <Text> </Text>
      ) : (
        lineParts.map((part_0, partIndex) => {
          if (part_0.highlight?.shimmerColor && part_0.highlight.color) {
            return (
              <Text key={partIndex}>
                {part_0.text.split('').map((char, charIndex) => (
                  <ShimmerChar
                    key={charIndex}
                    char={char}
                    index={part_0.start + charIndex}
                    glimmerIndex={glimmerIndex}
                    messageColor={part_0.highlight.color}
                    shimmerColor={part_0.highlight.shimmerColor}
                  />
                ))}
              </Text>
            )
          }
          return (
            <Text
              key={partIndex}
              color={part_0.highlight?.color}
              dimColor={part_0.highlight?.dimColor}
              inverse={part_0.highlight?.inverse}
            >
              <Ansi>{part_0.text}</Ansi>
            </Text>
          )
        })
      )}
    </Box>
  ))
  return (
    <Box ref={ref} flexDirection="column">
      {t3}
    </Box>
  )
}
