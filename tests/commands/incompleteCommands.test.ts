import { describe, expect, test } from 'bun:test'
import fork from '../../src/commands/fork/index.js'
import ide from '../../src/commands/ide/index.js'
import mobile from '../../src/commands/mobile/index.js'
import peers from '../../src/commands/peers/index.js'

describe('未完成命令的可发现性', () => {
  test.each([
    ['ide', ide],
    ['mobile', mobile],
    ['fork', fork],
    ['peers', peers],
  ])('/%s 在实现完成前保持隐藏', (_name, command) => {
    expect(command.isHidden).toBe(true)
  })
})
