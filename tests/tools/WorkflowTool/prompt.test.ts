import { describe, expect, test } from 'bun:test'
import {
  getWorkflowPrompt,
  getWorkflowSizeGuidelinePrompt,
} from '../../../src/tools/WorkflowTool/prompt.js'

describe('WorkflowTool prompt', () => {
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
