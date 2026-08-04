import { describe, expect, test } from 'bun:test'
import { getSimplePrompt } from '../../../src/tools/BashTool/prompt.js'

describe('BashTool prompt', () => {
  test('说明命令输出不一定直接展示给用户', () => {
    expect(getSimplePrompt()).toContain(
      'Command output is displayed to you, not reliably to the user.',
    )
  })
})
