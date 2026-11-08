import { describe, expect, test } from 'bun:test'
import {
  getBuiltinPluginSkillCommands,
  registerBuiltinPlugin,
} from '../../../src/services/plugins/builtinRegistry.js'
import { codeReviewSkill } from '../../../src/skills/bundled/codeReview.js'

describe('builtinRegistry', () => {
  test('内置插件转换后保留审查别名和唯一提示词实现', () => {
    registerBuiltinPlugin({
      name: 'code-review',
      description: codeReviewSkill.description,
      skills: [codeReviewSkill],
    })
    const commands = getBuiltinPluginSkillCommands()
    const command = commands.find((entry) => entry.name === 'code-review')
    expect(command?.aliases).toContain('review')
    expect(commands.filter((entry) => entry.name === 'review')).toHaveLength(0)
    expect(command?.type).toBe('prompt')
    if (command?.type === 'prompt') {
      expect(command.getPromptForCommand).toBe(codeReviewSkill.getPromptForCommand)
    }
  })
})
