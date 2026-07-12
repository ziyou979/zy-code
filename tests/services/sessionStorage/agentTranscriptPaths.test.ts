/**
 * agent transcript 多路径候选（worktree 冷恢复）
 */
import { describe, expect, test } from 'bun:test'
import { getAgentTranscriptPathCandidates } from '../../../src/services/sessionStorage/paths.js'
import { asAgentId } from '../../../src/types/ids.js'

describe('getAgentTranscriptPathCandidates', () => {
  test('返回至少一个路径且全部以 agent-*.jsonl 结尾', () => {
    const id = asAgentId('test-agent-uuid-0001')
    const paths = getAgentTranscriptPathCandidates(id)
    expect(paths.length).toBeGreaterThanOrEqual(1)
    for (const p of paths) {
      expect(p.endsWith(`agent-${id}.jsonl`)).toBe(true)
      expect(p.includes('subagents')).toBe(true)
    }
    // 无重复
    expect(new Set(paths).size).toBe(paths.length)
  })
})
