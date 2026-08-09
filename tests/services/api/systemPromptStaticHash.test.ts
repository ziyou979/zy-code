/**
 * Static system prompt 切分 golden：boundary 以左进 cacheable static，以右进 dynamic。
 * 不调用 getSystemPrompt()（含 cwd/git，不稳定）；锁 split 语义 + fixture hash。
 */
import { createHash } from 'node:crypto'
import { describe, expect, test } from 'bun:test'
import { SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '../../../src/constants/prompts.js'
import { splitSysPromptPrefix } from '../../../src/services/api/api.js'
import { asSystemPrompt } from '../../../src/services/api/systemPromptType.js'

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

describe('splitSysPromptPrefix static golden', () => {
  test('boundary 前后分别进入 static / dynamic 块', () => {
    const staticA = '# Intro\nYou are a stable agent harness.'
    const staticB = '# Harness\nTools run behind permissions.'
    const dynamicA = '# Environment\nWorking directory: /tmp/fixture'
    const dynamicB = '# Session\nDate changes every day'

    const prompt = asSystemPrompt([
      staticA,
      staticB,
      SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
      dynamicA,
      dynamicB,
    ])

    const blocks = splitSysPromptPrefix(prompt)
    const staticBlock = blocks.find((b) => b.shouldCache && b.text.includes('stable agent'))
    const dynamicBlock = blocks.find((b) => b.text.includes('Working directory'))

    expect(staticBlock).toBeDefined()
    expect(dynamicBlock).toBeDefined()
    expect(staticBlock!.text).toContain(staticA)
    expect(staticBlock!.text).toContain(staticB)
    expect(staticBlock!.text).not.toContain('Working directory')
    expect(dynamicBlock!.text).toContain(dynamicA)
    expect(dynamicBlock!.text).not.toContain('stable agent')

    // fixture 内容 hash：改 boundary 前顺序/文案会红，防误迁动态段
    const expectedStaticHash = sha256([staticA, staticB].join('\n\n'))
    expect(sha256(staticBlock!.text)).toBe(expectedStaticHash)
  })

  test('无 boundary 时整段视为 static cacheable', () => {
    const only = 'single block without boundary'
    const blocks = splitSysPromptPrefix(asSystemPrompt([only]))
    expect(blocks.length).toBe(1)
    expect(blocks[0]?.shouldCache).toBe(true)
    expect(blocks[0]?.text).toBe(only)
  })

  test('boundary 标记本身不出现在任一块 text 中', () => {
    const prompt = asSystemPrompt(['static', SYSTEM_PROMPT_DYNAMIC_BOUNDARY, 'dynamic'])
    for (const b of splitSysPromptPrefix(prompt)) {
      expect(b.text.includes(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)).toBe(false)
    }
  })
})
