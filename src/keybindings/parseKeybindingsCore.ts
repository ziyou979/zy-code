/**
 * keybindings.json 解析核心——async（loadKeybindings）与 sync
 * （loadKeybindingsSyncWithWarnings）两个加载路径共享，消除逐字重复的
 * bindings 提取、结构校验与错误文案。差异仅保留在调用方（文件读取方式、
 * 缓存写入、日志）。
 */
import { jsonParse } from '../services/infra/slowOperations.js'
import { isKeybindingBlockArray, type KeybindingBlock } from './types.js'
import type { KeybindingWarning } from './validate.js'

export type ParsedKeybindingsContent = {
  /** 提取出的用户绑定块；结构校验失败时为 null（调用方回退默认绑定） */
  userBlocks: KeybindingBlock[] | null
  /** 结构校验警告；为空表示提取成功 */
  warnings: KeybindingWarning[]
}

/**
 * 从 keybindings.json 原始内容中提取并校验 bindings 数组。
 * 处理两种结构错误：缺少 "bindings" 属性、bindings 非有效块数组。
 */
export function parseKeybindingsContent(content: string): ParsedKeybindingsContent {
  const parsed: unknown = jsonParse(content)

  // 从对象包装格式 { "bindings": [...] } 中提取 bindings 数组
  if (typeof parsed === 'object' && parsed !== null && 'bindings' in parsed) {
    const userBlocks = (parsed as { bindings: unknown }).bindings
    if (!isKeybindingBlockArray(userBlocks)) {
      const errorMessage = !Array.isArray(userBlocks)
        ? '"bindings" must be an array'
        : 'keybindings.json contains invalid block structure'
      const suggestion = !Array.isArray(userBlocks)
        ? 'Set "bindings" to an array of keybinding blocks'
        : 'Each block must have "context" (string) and "bindings" (object)'
      return {
        userBlocks: null,
        warnings: [
          {
            type: 'parse_error',
            severity: 'error',
            message: errorMessage,
            suggestion,
          },
        ],
      }
    }
    return { userBlocks, warnings: [] }
  }

  // 格式无效：缺少 bindings 属性
  return {
    userBlocks: null,
    warnings: [
      {
        type: 'parse_error',
        severity: 'error',
        message: 'keybindings.json must have a "bindings" array',
        suggestion: 'Use format: { "bindings": [ ... ] }',
      },
    ],
  }
}
