import { describe, expect, test } from 'bun:test'
import { cachedLexer } from '../../src/markdown/lexerCache.js'

describe('cachedLexer', () => {
  test('前五百字纯文本不应吞掉尾部代码块和列表', () => {
    const prefix = '正文'.repeat(300)
    expect(
      cachedLexer(`${prefix}\n\n\`\`\`ts\nconst x = 1\n\`\`\``).some((t) => t.type === 'code'),
    ).toBe(true)
    expect(cachedLexer(`${prefix}\n\n1) item`).some((t) => t.type === 'list')).toBe(true)
  })
  test('小文档复用解析结果，超大文档不驻留', () => {
    const small = '# cache small'
    expect(cachedLexer(small)).toBe(cachedLexer(small))
    const large = '# large\n' + 'x'.repeat(300000)
    expect(cachedLexer(large)).not.toBe(cachedLexer(large))
  })
  test('未达到条数上限时也按内容容量淘汰', () => {
    const content = (i: number) => `# document ${i}\n${'x'.repeat(20000)}`
    const first = cachedLexer(content(0))
    for (let i = 1; i < 180; i++) cachedLexer(content(i))
    expect(cachedLexer(content(0))).not.toBe(first)
  })
})
