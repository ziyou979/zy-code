/**
 * sed 编辑命令（-i flag 替换）的 parser。
 * 提取文件路径和替换模式，以启用类似文件编辑的渲染。
 */

import { randomBytes } from 'node:crypto'
import { tryParseShellCommand } from '../../shell-eval/bash/shellQuote.js'

// BRE→ERE 转换占位符（null 字节哨兵，永远不会出现在用户输入中）
const BACKSLASH_PLACEHOLDER = '\x00BACKSLASH\x00'
const PLUS_PLACEHOLDER = '\x00PLUS\x00'
const QUESTION_PLACEHOLDER = '\x00QUESTION\x00'
const PIPE_PLACEHOLDER = '\x00PIPE\x00'
const LPAREN_PLACEHOLDER = '\x00LPAREN\x00'
const RPAREN_PLACEHOLDER = '\x00RPAREN\x00'
const BACKSLASH_PLACEHOLDER_RE = new RegExp(BACKSLASH_PLACEHOLDER, 'g')
const PLUS_PLACEHOLDER_RE = new RegExp(PLUS_PLACEHOLDER, 'g')
const QUESTION_PLACEHOLDER_RE = new RegExp(QUESTION_PLACEHOLDER, 'g')
const PIPE_PLACEHOLDER_RE = new RegExp(PIPE_PLACEHOLDER, 'g')
const LPAREN_PLACEHOLDER_RE = new RegExp(LPAREN_PLACEHOLDER, 'g')
const RPAREN_PLACEHOLDER_RE = new RegExp(RPAREN_PLACEHOLDER, 'g')

export type SedEditInfo = {
  /** 正在编辑的文件路径 */
  filePath: string
  /** 搜索模式（regex） */
  pattern: string
  /** 替换字符串 */
  replacement: string
  /** 替换 flag（g、i 等） */
  flags: string
  /** 是否使用扩展 regex（-E 或 -r flag） */
  extendedRegex: boolean
}

/**
 * 检查命令是否为 sed 原地编辑命令。
 * 仅对简单的 sed -i 's/pattern/replacement/flags' file 命令返回 true。
 */
export function isSedInPlaceEdit(command: string): boolean {
  const info = parseSedEditCommand(command)
  return info !== null
}

/**
 * 解析 sed 编辑命令并提取编辑信息。
 * 命令不是有效的 sed 原地编辑时返回 null。
 */
export function parseSedEditCommand(command: string): SedEditInfo | null {
  const trimmed = command.trim()

  // 必须以 sed 开头
  const sedMatch = trimmed.match(/^\s*sed\s+/)
  if (!sedMatch) {
    return null
  }

  const withoutSed = trimmed.slice(sedMatch[0].length)
  const parseResult = tryParseShellCommand(withoutSed)
  if (!parseResult.success) {
    return null
  }
  const tokens = parseResult.tokens

  // 仅提取字符串 token
  const args: string[] = []
  for (const token of tokens) {
    if (typeof token === 'string') {
      args.push(token)
    } else if (
      typeof token === 'object' &&
      token !== null &&
      'op' in token &&
      token.op === 'glob'
    ) {
      // Glob 模式对该简单 parser 而言过于复杂
      return null
    }
  }

  // 解析 flag 和参数
  let hasInPlaceFlag = false
  let extendedRegex = false
  let expression: string | null = null
  let filePath: string | null = null

  let i = 0
  while (i < args.length) {
    const arg = args[i]!

    // 处理 -i flag（可带或不带备份后缀）
    if (arg === '-i' || arg === '--in-place') {
      hasInPlaceFlag = true
      i++
      // macOS 上 -i 需要后缀参数（即使是空字符串）。
      // 检查下一个参数是否像备份后缀（为空或以点开头），
      // 不要消耗 flag（-E、-r）或 sed 表达式（以 s、y、d 开头）。
      if (i < args.length) {
        const nextArg = args[i]
        // If next arg is empty string or starts with dot, it's a backup suffix
        if (
          typeof nextArg === 'string' &&
          !nextArg.startsWith('-') &&
          (nextArg === '' || nextArg.startsWith('.'))
        ) {
          i++ // 跳过备份后缀
        }
      }
      continue
    }
    if (arg.startsWith('-i')) {
      // -i.bak 或类似形式（内联后缀）
      hasInPlaceFlag = true
      i++
      continue
    }

    // 处理扩展 regex flag
    if (arg === '-E' || arg === '-r' || arg === '--regexp-extended') {
      extendedRegex = true
      i++
      continue
    }

    // 处理带表达式的 -e flag
    if (arg === '-e' || arg === '--expression') {
      if (i + 1 < args.length && typeof args[i + 1] === 'string') {
        // 仅支持单个表达式
        if (expression !== null) {
          return null
        }
        expression = args[i + 1]!
        i += 2
        continue
      }
      return null
    }
    if (arg.startsWith('--expression=')) {
      if (expression !== null) {
        return null
      }
      expression = arg.slice('--expression='.length)
      i++
      continue
    }

    // 跳过其他无法理解的 flag
    if (arg.startsWith('-')) {
      // 未知 flag，无法安全解析
      return null
    }

    // 非 flag 参数
    if (expression === null) {
      // 第一个非 flag 参数是表达式
      expression = arg
    } else if (filePath === null) {
      // 第二个非 flag 参数是文件路径
      filePath = arg
    } else {
      // 简单渲染不支持多个文件
      return null
    }

    i++
  }

  // 必须同时有 -i flag、表达式和文件路径
  if (!hasInPlaceFlag || !expression || !filePath) {
    return null
  }

  // 解析替换表达式：s/pattern/replacement/flags
  // 为保持简单，仅支持 / 作为分隔符
  const substMatch = expression.match(/^s\//)
  if (!substMatch) {
    return null
  }

  const rest = expression.slice(2) // 跳过 's/'

  // 通过跟踪转义字符找到 pattern 和 replacement
  let pattern = ''
  let replacement = ''
  let flags = ''
  let state: 'pattern' | 'replacement' | 'flags' = 'pattern'
  let j = 0

  while (j < rest.length) {
    const char = rest[j]!

    if (char === '\\' && j + 1 < rest.length) {
      // 转义字符
      if (state === 'pattern') {
        pattern += char + rest[j + 1]
      } else if (state === 'replacement') {
        replacement += char + rest[j + 1]
      } else {
        flags += char + rest[j + 1]
      }
      j += 2
      continue
    }

    if (char === '/') {
      if (state === 'pattern') {
        state = 'replacement'
      } else if (state === 'replacement') {
        state = 'flags'
      } else {
        // flag 中出现额外分隔符，不符合预期
        return null
      }
      j++
      continue
    }

    if (state === 'pattern') {
      pattern += char
    } else if (state === 'replacement') {
      replacement += char
    } else {
      flags += char
    }
    j++
  }

  // 必须已找到三部分（pattern、replacement 分隔符和可选 flag）
  if (state !== 'flags') {
    return null
  }

  // 校验 flag，仅允许安全的替换 flag
  const validFlags = /^[gpimIM1-9]*$/
  if (!validFlags.test(flags)) {
    return null
  }

  return {
    filePath,
    pattern,
    replacement,
    flags,
    extendedRegex,
  }
}

/**
 * 对文件内容应用 sed 替换。
 * 返回应用替换后的新内容。
 */
export function applySedSubstitution(content: string, sedInfo: SedEditInfo): string {
  // 将 sed pattern 转换为 JavaScript regex
  let regexFlags = ''

  // 处理全局 flag
  if (sedInfo.flags.includes('g')) {
    regexFlags += 'g'
  }

  // 处理忽略大小写 flag（sed 中的 i 或 I）
  if (sedInfo.flags.includes('i') || sedInfo.flags.includes('I')) {
    regexFlags += 'i'
  }

  // 处理多行 flag（sed 中的 m 或 M）
  if (sedInfo.flags.includes('m') || sedInfo.flags.includes('M')) {
    regexFlags += 'm'
  }

  // 将 sed pattern 转换为 JavaScript regex pattern
  let jsPattern = sedInfo.pattern
    // 将 \/ 反转义为 /
    .replace(/\\\//g, '/')

  // BRE 模式（无 -E flag）下，元字符的转义语义相反：
  // BRE: \+ means "one or more", + is literal
  // ERE/JS: + means "one or more", \+ is literal
  // 需要将 BRE 转义转换为 JavaScript regex 使用的 ERE
  if (!sedInfo.extendedRegex) {
    jsPattern = jsPattern
      // 步骤 1：先保护字面反斜杠 (\\)：在 BRE 和 ERE 中，\\ 都表示字面反斜杠
      .replace(/\\\\/g, BACKSLASH_PLACEHOLDER)
      // 步骤 2：用占位符替换已转义元字符（它们在 JS 中应变为未转义）
      .replace(/\\\+/g, PLUS_PLACEHOLDER)
      .replace(/\\\?/g, QUESTION_PLACEHOLDER)
      .replace(/\\\|/g, PIPE_PLACEHOLDER)
      .replace(/\\\(/g, LPAREN_PLACEHOLDER)
      .replace(/\\\)/g, RPAREN_PLACEHOLDER)
      // 步骤 3：转义未转义元字符（它们在 BRE 中是字面字符）
      .replace(/\+/g, '\\+')
      .replace(/\?/g, '\\?')
      .replace(/\|/g, '\\|')
      .replace(/\(/g, '\\(')
      .replace(/\)/g, '\\)')
      // 步骤 4：将占位符替换为 JS 等价形式
      .replace(BACKSLASH_PLACEHOLDER_RE, '\\\\')
      .replace(PLUS_PLACEHOLDER_RE, '+')
      .replace(QUESTION_PLACEHOLDER_RE, '?')
      .replace(PIPE_PLACEHOLDER_RE, '|')
      .replace(LPAREN_PLACEHOLDER_RE, '(')
      .replace(RPAREN_PLACEHOLDER_RE, ')')
  }

  // 反转义 replacement 中 sed 专用的转义序列，
  // 例如将 \n 转换为换行，将 & 转换为 $&（匹配项）。
  // 使用带随机 salt 的唯一占位符防止注入攻击。
  const salt = randomBytes(8).toString('hex')
  const ESCAPED_AMP_PLACEHOLDER = `___ESCAPED_AMPERSAND_${salt}___`
  const jsReplacement = sedInfo.replacement
    // Unescape \/ to /
    .replace(/\\\//g, '/')
    // First escape \& to a placeholder
    .replace(/\\&/g, ESCAPED_AMP_PLACEHOLDER)
    // Convert & to $& (full match) - use $$& to get literal $& in output
    .replace(/&/g, '$$&')
    // Convert placeholder back to literal &
    .replace(new RegExp(ESCAPED_AMP_PLACEHOLDER, 'g'), '&')

  try {
    const regex = new RegExp(jsPattern, regexFlags)
    return content.replace(regex, jsReplacement)
  } catch {
    // regex 无效时返回原始内容
    return content
  }
}
