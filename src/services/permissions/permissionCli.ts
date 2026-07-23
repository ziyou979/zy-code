/**
 * CLI 参数解析工具函数。
 *
 * 从 permissionSetup.ts 提取，包含 --allowed-tools、--disallowed-tools、
 * --base-tools 的解析逻辑。纯函数，无 IO 或外部状态依赖。
 */
import { getToolsForDefaultPreset, parseToolPreset } from '../../tools/tools.js'
import {
  normalizeLegacyToolName,
  permissionRuleValueFromString,
  permissionRuleValueToString,
} from './permissionRuleParser.js'

/**
 * 从 CLI 解析基础工具规格
 * 处理预设名称（default、none）和自定义工具列表
 */
export function parseBaseToolsFromCLI(baseTools: string[]): string[] {
  // 拼接数组所有元素，检查是否为单个预设名称
  const joinedInput = baseTools.join(' ').trim()
  const preset = parseToolPreset(joinedInput)

  if (preset) {
    return getToolsForDefaultPreset()
  }

  // 作为自定义工具列表解析，使用与 allowedTools/disallowedTools 相同的解析逻辑
  const parsedTools = parseToolListFromCLI(baseTools)

  return parsedTools
}

export function parseToolListFromCLI(tools: string[]): string[] {
  if (tools.length === 0) {
    return []
  }

  const result: string[] = []

  // 处理数组中的每个字符串
  for (const toolString of tools) {
    if (!toolString) {
      continue
    }

    let current = ''
    let isInParens = false

    // 解析字符串中的每个字符
    for (const char of toolString) {
      switch (char) {
        case '(':
          isInParens = true
          current += char
          break
        case ')':
          isInParens = false
          current += char
          break
        case ',':
          if (isInParens) {
            current += char
          } else {
            // 逗号分隔符 — 推送当前工具并开始新的工具
            if (current.trim()) {
              result.push(current.trim())
            }
            current = ''
          }
          break
        case ' ':
          if (isInParens) {
            current += char
          } else if (current.trim()) {
            // 空格分隔符 — 推送当前工具并开始新的工具
            result.push(current.trim())
            current = ''
          }
          break
        default:
          current += char
      }
    }

    // 推送任何剩余的工具
    if (current.trim()) {
      result.push(current.trim())
    }
  }

  return result
}
