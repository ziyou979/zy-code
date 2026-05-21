import { Text } from '../../ink.js'
import type { Theme } from '../../utils/theme.js'

type Props = {
  /**
   * How much progress to display, between 0 and 1 inclusive
   */
  ratio: number // [0, 1]

  /**
   * How many characters wide to draw the progress bar
   */
  width: number // how many characters wide

  /**
   * Optional color for the filled portion of the bar
   */
  fillColor?: keyof Theme

  /**
   * Optional color for the empty portion of the bar
   */
  emptyColor?: keyof Theme
}
const BLOCKS = [' ', '▏', '▎', '▍', '▌', '▋', '▊', '▉', '█']
export function ProgressBar({ ratio: inputRatio, width, fillColor, emptyColor }: Props) {
  const ratio = Math.min(1, Math.max(0, inputRatio))
  const whole = Math.floor(ratio * width)
  const filledBlock = BLOCKS[BLOCKS.length - 1].repeat(whole)
  const segments = [filledBlock]
  if (whole < width) {
    const remainder = ratio * width - whole
    const middle = Math.floor(remainder * BLOCKS.length)
    segments.push(BLOCKS[middle])
    const empty = width - whole - 1
    if (empty > 0) {
      const emptyBlock = BLOCKS[0].repeat(empty)
      segments.push(emptyBlock)
    }
  }
  const progressBar = segments.join('')
  return (
    <Text color={fillColor} backgroundColor={emptyColor}>
      {progressBar}
    </Text>
  )
}
