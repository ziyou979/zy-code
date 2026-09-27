import { describe, expect, test } from 'bun:test'
import {
  getWorkflowPrompt,
  getWorkflowSizeGuidelinePrompt,
} from '../../../src/tools/WorkflowTool/prompt.js'

describe('WorkflowTool prompt', () => {
  test('常驻说明保留授权约束，脚本 API 按需加载', async () => {
    const prompt = await getWorkflowPrompt(false)
    expect(prompt).toContain('ONLY call this tool when the user has explicitly opted')
    expect(prompt).toContain('load the workflow-authoring skill')
    expect(prompt).not.toContain('Script body hooks:')
    expect(prompt).not.toContain('## Resume')
  })

  test('缺少 Skill 工具时直接提供同一份参考文档', async () => {
    const prompt = await getWorkflowPrompt(false, 'medium', true, false)
    expect(prompt).toContain('Skill tool is unavailable')
    expect(prompt).toContain('Script body hooks:')
    expect(prompt).toContain('## Resume')
    expect(prompt).toContain('Loading this skill does not authorize running Workflow')
    expect(prompt).not.toContain('load the workflow-authoring skill with the Skill tool')
  })
  test('默认注入 medium 的少于 15 个 agent 建议', async () => {
    const prompt = await getWorkflowPrompt(false)

    expect(prompt).toContain('default workflow size guideline: medium')
    expect(prompt).toContain('keep workflows under 15 agents')
  })

  test('显式 unrestricted 时不注入规模建议', async () => {
    const prompt = await getWorkflowPrompt(false, 'unrestricted', false)

    expect(getWorkflowSizeGuidelinePrompt('unrestricted')).toBeNull()
    expect(prompt).not.toContain('workflow size guideline')
  })

  test('显式 small 使用配置态措辞', () => {
    const prompt = getWorkflowSizeGuidelinePrompt('small', false)

    expect(prompt).toContain('configured for this session: small')
    expect(prompt).toContain('under 5 agents')
    expect(prompt).not.toContain('/config')
  })
})
