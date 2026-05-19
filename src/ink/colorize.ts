import chalk from 'chalk'
import type { Color, TextStyles } from './styles.js'

/**
 * xterm.js（VS Code、Cursor、code-server、Coder）自 2017 年起支持真彩色，
 * 但 code-server/Coder 容器通常不设置 COLORTERM=truecolor。
 * chalk 的 supports-color 不识别 TERM_PROGRAM=vscode
 *（它只知道 iTerm.app/Apple_Terminal），所以回退到 -256color 正则 → level 2。
 * 在 level 2 时，chalk.rgb() 降级为最近的 6×6×6 立方体颜色：
 * rgb(215,119,87)（ZY 橙色）→ idx 174 rgb(215,135,135) — 褪色的鲑鱼色。
 *
 * 限制为 level === 2（不是 < 3）以尊重 NO_COLOR / FORCE_COLOR=0 —
 * 这些产生 level 0 并且是明确的"无颜色"请求。桌面版 VS Code
 * 自身设置 COLORTERM=truecolor，所以这里对其无影响（已经是 3）。
 *
 * 必须在 tmux 钳位之前运行 — 如果 tmux 运行在 VS Code
 * 终端内部，tmux 的 passthrough 限制获胜，我们希望 level 2。
 */
function boostChalkLevelForXtermJs(): boolean {
  if (process.env.TERM_PROGRAM === 'vscode' && chalk.level === 2) {
    chalk.level = 3
    return true
  }
  return false
}

/**
 * tmux 正确解析真彩色 SGR（\e[48;2;r;g;bm）到其单元格缓冲区，
 * 但其客户端侧发射器仅在外部终端通告 Tc/RGB 能力时
 *（通过 terminal-overrides）才将真彩色重新发射到外部终端。
 * 默认 tmux 配置不设置这个，所以 tmux 向 iTerm2 等发射时
 * 不带 bg 序列 — 外部终端的缓冲区有 bg=default → 深色配置文件上显示黑色。
 * 钳位到 level 2 使 chalk 发射 256 色（\e[48;5;Nm），
 * tmux 可以干净地传递。grey93（255）在视觉上与 rgb(240,240,240) 相同。
 *
 * 已设置 `terminal-overrides ,*:Tc` 的用户会收到技术上不必要的降级，
 * 但视觉差异不可察觉。查询 `tmux show -gv terminal-overrides` 来检测
 * 会在启动时添加子进程 — 不值得。
 *
 * $TMUX 是由 tmux 自身设置的 pty 生命周期环境变量；
 * 它永远不会来自 globalSettings.env，所以在这里读取是正确的。
 * chalk 是单例，所以这会钳位整个应用的所有真彩色输出（fg+bg+hex）。
 */
function clampChalkLevelForTmux(): boolean {
  // background.ts 在 attach 之前设置 terminal-overrides :Tc，所以真彩色可以
  // 传递 — 跳过钳位。为正确配置 tmux 的用户提供的通用出口。
  if (process.env.ZY_CODE_TMUX_TRUECOLOR) return false
  if (process.env.TMUX && chalk.level > 2) {
    chalk.level = 2
    return true
  }
  return false
}
// 在模块加载时计算一次 — 终端/tmux 环境不会在会话中变化。
// 顺序很重要：先提升，这样如果 tmux 运行在 VS Code 终端内部，
// tmux 钳位可以重新钳位。导出用于调试 — 如果未使用则被 tree-shake。
export const CHALK_BOOSTED_FOR_XTERMJS = boostChalkLevelForXtermJs()
export const CHALK_CLAMPED_FOR_TMUX = clampChalkLevelForTmux()

export type ColorType = 'foreground' | 'background'

const RGB_REGEX = /^rgb\(\s?(\d+),\s?(\d+),\s?(\d+)\s?\)$/
const ANSI_REGEX = /^ansi256\(\s?(\d+)\s?\)$/

export const colorize = (str: string, color: string | undefined, type: ColorType): string => {
  if (!color) {
    return str
  }

  if (color.startsWith('ansi:')) {
    const value = color.substring('ansi:'.length)
    switch (value) {
      case 'black':
        return type === 'foreground' ? chalk.black(str) : chalk.bgBlack(str)
      case 'red':
        return type === 'foreground' ? chalk.red(str) : chalk.bgRed(str)
      case 'green':
        return type === 'foreground' ? chalk.green(str) : chalk.bgGreen(str)
      case 'yellow':
        return type === 'foreground' ? chalk.yellow(str) : chalk.bgYellow(str)
      case 'blue':
        return type === 'foreground' ? chalk.blue(str) : chalk.bgBlue(str)
      case 'magenta':
        return type === 'foreground' ? chalk.magenta(str) : chalk.bgMagenta(str)
      case 'cyan':
        return type === 'foreground' ? chalk.cyan(str) : chalk.bgCyan(str)
      case 'white':
        return type === 'foreground' ? chalk.white(str) : chalk.bgWhite(str)
      case 'blackBright':
        return type === 'foreground' ? chalk.blackBright(str) : chalk.bgBlackBright(str)
      case 'redBright':
        return type === 'foreground' ? chalk.redBright(str) : chalk.bgRedBright(str)
      case 'greenBright':
        return type === 'foreground' ? chalk.greenBright(str) : chalk.bgGreenBright(str)
      case 'yellowBright':
        return type === 'foreground' ? chalk.yellowBright(str) : chalk.bgYellowBright(str)
      case 'blueBright':
        return type === 'foreground' ? chalk.blueBright(str) : chalk.bgBlueBright(str)
      case 'magentaBright':
        return type === 'foreground' ? chalk.magentaBright(str) : chalk.bgMagentaBright(str)
      case 'cyanBright':
        return type === 'foreground' ? chalk.cyanBright(str) : chalk.bgCyanBright(str)
      case 'whiteBright':
        return type === 'foreground' ? chalk.whiteBright(str) : chalk.bgWhiteBright(str)
    }
  }

  if (color.startsWith('#')) {
    return type === 'foreground' ? chalk.hex(color)(str) : chalk.bgHex(color)(str)
  }

  if (color.startsWith('ansi256')) {
    const matches = ANSI_REGEX.exec(color)

    if (!matches) {
      return str
    }

    const value = Number(matches[1])

    return type === 'foreground' ? chalk.ansi256(value)(str) : chalk.bgAnsi256(value)(str)
  }

  if (color.startsWith('rgb')) {
    const matches = RGB_REGEX.exec(color)

    if (!matches) {
      return str
    }

    const firstValue = Number(matches[1])
    const secondValue = Number(matches[2])
    const thirdValue = Number(matches[3])

    return type === 'foreground'
      ? chalk.rgb(firstValue, secondValue, thirdValue)(str)
      : chalk.bgRgb(firstValue, secondValue, thirdValue)(str)
  }

  return str
}

/**
 * 使用 chalk 将 TextStyles 应用到字符串。
 * 这是解析 ANSI 码的逆过程 — 我们从结构化样式生成它们。
 * 主题解析发生在组件层，而不是这里。
 */
export function applyTextStyles(text: string, styles: TextStyles): string {
  let result = text

  // 按所需嵌套的逆序应用样式。
  // chalk 包裹文本，所以后面的调用成为外部包裹器。
  // 所需顺序（从外到内）：
  //   background > foreground > 文本修饰符
  // 所以我们应用：先文本修饰符，然后 foreground，最后 background。

  if (styles.inverse) {
    result = chalk.inverse(result)
  }

  if (styles.strikethrough) {
    result = chalk.strikethrough(result)
  }

  if (styles.underline) {
    result = chalk.underline(result)
  }

  if (styles.italic) {
    result = chalk.italic(result)
  }

  if (styles.bold) {
    result = chalk.bold(result)
  }

  if (styles.dim) {
    result = chalk.dim(result)
  }

  if (styles.color) {
    // 颜色现在是原始颜色值（主题解析发生在组件层）
    result = colorize(result, styles.color, 'foreground')
  }

  if (styles.backgroundColor) {
    // backgroundColor 现在是原始颜色值
    result = colorize(result, styles.backgroundColor, 'background')
  }

  return result
}

/**
 * 将原始颜色值应用到文本。
 * 主题解析应该发生在组件层，而不是这里。
 */
export function applyColor(text: string, color: Color | undefined): string {
  if (!color) {
    return text
  }
  return colorize(text, color, 'foreground')
}
