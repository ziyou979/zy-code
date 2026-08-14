/**
 * 快捷键模板生成器。
 * 为 ~/.zy/keybindings.json 生成带完整说明的模板文件。
 */

import { jsonStringify } from '../services/infra/slowOperations.js'
import { DEFAULT_BINDINGS } from './defaultBindings.js'
import { NON_REBINDABLE, normalizeKeyForComparison } from './reservedShortcuts.js'
import type { KeybindingBlock } from './types.js'

/**
 * 过滤无法重新绑定的保留快捷键。
 * 这些快捷键会触发 /doctor 警告，因此不写入模板。
 */
function filterReservedShortcuts(blocks: KeybindingBlock[]): KeybindingBlock[] {
  const reservedKeys = new Set(NON_REBINDABLE.map((r) => normalizeKeyForComparison(r.key)))

  return blocks
    .map((block) => {
      const filteredBindings: Record<string, string | null> = {}
      for (const [key, action] of Object.entries(block.bindings)) {
        if (!reservedKeys.has(normalizeKeyForComparison(key))) {
          filteredBindings[key] = action
        }
      }
      return { context: block.context, bindings: filteredBindings }
    })
    .filter((block) => Object.keys(block.bindings).length > 0)
}

/**
 * 生成 keybindings.json 模板内容。
 * 创建包含所有可自定义默认绑定的有效 JSON 文件。
 */
export function generateKeybindingsTemplate(): string {
  // 过滤无法重新绑定的保留快捷键
  const bindings = filterReservedShortcuts(DEFAULT_BINDINGS)

  // 格式化为包含 bindings 数组的对象包装结构
  const config = {
    $schema: 'https://www.schemastore.org/zy-code-keybindings.json',
    $docs: 'https://code.zy.com/docs/en/keybindings',
    bindings,
  }

  return `${jsonStringify(config, null, 2)}\n`
}
