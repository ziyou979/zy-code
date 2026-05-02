import supportsHyperlinksLib from 'supports-hyperlinks'

// 额外支持 OSC 8 超链接但未被 supports-hyperlinks 库检测到的终端。
// 同时检查 TERM_PROGRAM 和 LC_TERMINAL（后者在 tmux 内仍然保留）。
export const ADDITIONAL_HYPERLINK_TERMINALS = [
  'ghostty',
  'Hyper',
  'kitty',
  'alacritty',
  'iTerm.app',
  'iTerm2',
]

type EnvLike = Record<string, string | undefined>

type SupportsHyperlinksOptions = {
  env?: EnvLike
  stdoutSupported?: boolean
}

/**
 * 判断标准输出是否支持 OSC 8 超链接。
 * 在 supports-hyperlinks 库基础上扩展了额外的终端检测。
 * @param options 可选覆盖，用于测试（env、stdoutSupported）
 */
export function supportsHyperlinks(options?: SupportsHyperlinksOptions): boolean {
  const stdoutSupported = options?.stdoutSupported ?? supportsHyperlinksLib.stdout
  if (stdoutSupported) {
    return true
  }

  const env = options?.env ?? process.env

  // 检查 supports-hyperlinks 未检测到的额外终端
  const termProgram = env['TERM_PROGRAM']
  if (termProgram && ADDITIONAL_HYPERLINK_TERMINALS.includes(termProgram)) {
    return true
  }

  // LC_TERMINAL 由某些终端（如 iTerm2）设置，并在 tmux 内保留，
  // 此时 TERM_PROGRAM 会被覆盖为 'tmux'。
  const lcTerminal = env['LC_TERMINAL']
  if (lcTerminal && ADDITIONAL_HYPERLINK_TERMINALS.includes(lcTerminal)) {
    return true
  }

  // Kitty 设置 TERM=xterm-kitty
  const term = env['TERM']
  if (term?.includes('kitty')) {
    return true
  }

  return false
}
