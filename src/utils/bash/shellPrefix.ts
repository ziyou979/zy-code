import { quote } from './shellQuote.js'

/**
 * 解析可能包含可执行文件路径和参数的 shell 前缀。
 *
 * 示例：
 * - "bash" -> 引用为 'bash'
 * - "/usr/bin/bash -c" -> 引用为 '/usr/bin/bash' -c
 * - "C:\Program Files\Git\bin\bash.exe -c" -> 引用为 'C:\Program Files\Git\bin\bash.exe' -c
 *
 * @param prefix 包含可执行文件和可选参数的 shell 前缀字符串
 * @param command 要执行的命令
 * @returns 格式正确且组件已引用的命令字符串
 */
export function formatShellPrefixCommand(prefix: string, command: string): string {
  // 在最后一个短横线前的空格处分割，以分离可执行文件和参数
  const spaceBeforeDash = prefix.lastIndexOf(' -')
  if (spaceBeforeDash > 0) {
    const execPath = prefix.substring(0, spaceBeforeDash)
    const args = prefix.substring(spaceBeforeDash + 1)
    return `${quote([execPath])} ${args} ${quote([command])}`
  } else {
    return `${quote([prefix])} ${quote([command])}`
  }
}
