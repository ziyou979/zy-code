import { afterEach, describe, expect, test } from 'bun:test'
import { clearBundledSkills, getBundledSkills } from '../../src/skills/bundledSkills.js'
import {
  registerWorkflowAuthoringSkill,
  WORKFLOW_AUTHORING_PROMPT,
} from '../../src/skills/bundled/workflowAuthoring.js'
import type { ToolUseContext } from '../../src/tools/tool.js'

afterEach(() => clearBundledSkills())

describe('workflow-authoring', () => {
  test('内置 skill 可供模型加载且不暴露为用户命令，不附带工具授权', async () => {
    registerWorkflowAuthoringSkill()
    const skill = getBundledSkills().find((command) => command.name === 'workflow-authoring')
    expect(skill?.type).toBe('prompt')
    if (skill?.type !== 'prompt') {
      throw new Error('Missing workflow-authoring skill')
    }
    expect(skill.userInvocable).toBe(false)
    expect(skill.disableModelInvocation).toBe(false)
    expect(skill.allowedTools).toEqual([])
    // 此 skill 只返回静态编写文档，不读取运行时上下文。
    expect(await skill.getPromptForCommand('', {} as ToolUseContext)).toEqual([
      { type: 'text', text: WORKFLOW_AUTHORING_PROMPT },
    ])
  })
})
