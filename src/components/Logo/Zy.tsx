import { Box, RawAnsi, useTheme } from '../../ink/index.js'
import { colorize } from '../../ink/colorize.js'
import { env } from '../../services/environment/env.js'
import { getTheme } from '../../services/environment/theme.js'

export type ZySize = 'large' | 'compact'

type Props = {
  size?: ZySize
}

// 从参考图提取的橙色区域点阵：外框斜线和内部几何块均保留在原始网格中。
const ZY_DOTS: readonly string[] = [
  '1111000000000000000000000000000000000000',
  '1111111100000000000000000000000000000000',
  '1111111111100000000000000000000000000000',
  '1111000111111100000000000000000000000000',
  '1111000000001111110000000000000000000000',
  '1111000000000000011110000000000000000000',
  '1111000000000000000000000000000000000000',
  '0111000000000000000000000000000000000000',
  '0111101111111111111110111111110000001111',
  '0111101111111111111100111111110000011110',
  '0111101111111111111100111111110000011110',
  '0111100000011111111100111111111000111100',
  '0011110000111111111000111111111001111000',
  '0011110001111111110000111111111011110000',
  '0011110011111111100000011111111011110000',
  '0011110011111111000000011111111111100000',
  '0011111011111111000000011111111111000000',
  '0011111011111110000000011111111110000000',
  '0001111011111100000000011111111110000000',
  '0001111011111000000000011111111100000000',
  '0001111001110000000000011111111000000000',
  '0001111101100000000000011111111000000000',
  '0001111101100000000000011111110000000000',
  '0000111100000000000000111111110000000000',
  '0000111100000000000000111111110000000000',
  '0000111110111111000000111111100000000000',
  '0000111110111111000001111111100000000000',
  '0000011110111111000001111111100000000000',
  '0000011110000000000000000000000000000000',
  '0000011110000000000000000000000000000000',
  '0000011111000000011111111100000000000000',
  '0000011111111111111111110000000000000000',
  '0000001111111111111100000000000000000000',
  '0000001111111111100000000000000000000000',
  '0000001111111110000000000000000000000000',
  '0000000111110000000000000000000000000000',
]

const ZY_DOT_SIZES: Record<ZySize, { width: number; height: number }> = {
  large: { width: 40, height: 36 },
  compact: { width: 28, height: 24 },
}

const BRAILLE_DOT_BITS: readonly (readonly [number, number, number])[] = [
  [0, 0, 0x01],
  [0, 1, 0x02],
  [0, 2, 0x04],
  [1, 0, 0x08],
  [1, 1, 0x10],
  [1, 2, 0x20],
  [0, 3, 0x40],
  [1, 3, 0x80],
]

function resizeDotGrid(grid: readonly string[], width: number, height: number): string[] {
  const sourceHeight = grid.length
  const sourceWidth = grid[0]?.length ?? 0
  if (sourceWidth === 0 || sourceHeight === 0) {
    return []
  }
  return Array.from({ length: height }, (_, y) => {
    const sourceRow =
      grid[Math.min(sourceHeight - 1, Math.floor(((y + 0.5) * sourceHeight) / height))] ?? ''
    return Array.from(
      { length: width },
      (_, x) =>
        sourceRow[Math.min(sourceWidth - 1, Math.floor(((x + 0.5) * sourceWidth) / width))] ?? '0',
    ).join('')
  })
}

// 一个 Braille 字符承载 2×4 个点，直接把提取出的点阵压缩成终端字符。
function renderBrailleRows(grid: readonly string[], themeColor: string): string[] {
  const rows: string[] = []
  const height = grid.length
  const width = grid[0]?.length ?? 0
  for (let y = 0; y < height; y += 4) {
    const cells: string[] = []
    for (let x = 0; x < width; x += 2) {
      let bits = 0
      for (const [dotX, dotY, bit] of BRAILLE_DOT_BITS) {
        if (grid[y + dotY]?.[x + dotX] === '1') {
          bits |= bit
        }
      }
      cells.push(
        bits === 0 ? ' ' : colorize(String.fromCodePoint(0x2800 + bits), themeColor, 'foreground'),
      )
    }
    rows.push(cells.join(''))
  }
  return rows
}

export function Zy(props: Props | undefined) {
  const size = props?.size ?? 'large'
  const dotSize = ZY_DOT_SIZES[size]
  const [themeName] = useTheme()
  const theme = getTheme(themeName)
  const grid = resizeDotGrid(ZY_DOTS, dotSize.width, dotSize.height)
  const lines = renderBrailleRows(grid, theme.zy)
  const width = dotSize.width / 2
  if (env.terminal === 'Apple_Terminal') {
    return <AppleTerminalZy lines={lines} width={width} />
  }
  return <RawAnsi lines={lines} width={width} />
}

function AppleTerminalZy(props: { lines: string[]; width: number }) {
  const { lines, width } = props
  return (
    <Box flexDirection="column" alignItems="center">
      <RawAnsi lines={lines} width={width} />
    </Box>
  )
}
