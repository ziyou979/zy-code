/**
 * 粘贴折叠/同文展开（对齐 CC 2.1.207）
 */
import { describe, expect, test } from 'bun:test'
import {
  expandExistingPasteRefsInInput,
  findExistingPastedTextId,
} from '../../../src/components/PromptInput/inputPaste.js'
import { formatPastedTextRef } from '../../../src/history.js'
import type { PastedContent } from '../../../src/utils/config.js'

describe('findExistingPastedTextId', () => {
  test('按内容精确匹配已有 text paste', () => {
    const body = 'line1\nline2\n'.repeat(50)
    const pasted: Record<number, PastedContent> = {
      1: { id: 1, type: 'text', content: body },
      2: { id: 2, type: 'image', content: 'base64...' },
    }
    expect(findExistingPastedTextId(body, pasted)).toBe(1)
    expect(findExistingPastedTextId('other', pasted)).toBeUndefined()
  })
})

describe('expandExistingPasteRefsInInput', () => {
  test('将 [Pasted text #N] 展开为全文', () => {
    const body = 'hello\nworld\nextra'
    const numLines = 2
    const input = `prefix ${formatPastedTextRef(3, numLines)} suffix`
    const expanded = expandExistingPasteRefsInInput(input, 3, body)
    expect(expanded).toBe(`prefix ${body} suffix`)
  })

  test('input 中无该 id 的 placeholder 时返回 null', () => {
    expect(expandExistingPasteRefsInInput('no paste here', 1, 'x')).toBeNull()
  })

  test('同 id 多处引用全部展开', () => {
    const body = 'SAME'
    const ref = formatPastedTextRef(1, 0)
    const input = `${ref} and ${ref}`
    expect(expandExistingPasteRefsInInput(input, 1, body)).toBe('SAME and SAME')
  })
})
