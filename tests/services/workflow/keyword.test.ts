import { describe, expect, test } from 'bun:test'
import {
  findWorkflowTriggerPositions,
  hasWorkflowKeyword,
} from '../../../src/services/workflow/keyword.js'

describe('workflow keyword detection', () => {
  describe('hasWorkflowKeyword', () => {
    test('detects "workflow" in plain text', () => {
      expect(hasWorkflowKeyword('please run a workflow for this')).toBe(true)
    })

    test('detects "workflows" plural', () => {
      expect(hasWorkflowKeyword('use workflows to do this')).toBe(true)
    })

    test('case-insensitive', () => {
      expect(hasWorkflowKeyword('Run a Workflow')).toBe(true)
      expect(hasWorkflowKeyword('WORKFLOW please')).toBe(true)
    })

    test('rejects slash commands', () => {
      expect(hasWorkflowKeyword('/workflows')).toBe(false)
      expect(hasWorkflowKeyword('/workflow status')).toBe(false)
    })

    test('rejects inside backticks', () => {
      expect(hasWorkflowKeyword('run `workflow` command')).toBe(false)
    })

    test('rejects inside double quotes', () => {
      expect(hasWorkflowKeyword('search for "workflow" in docs')).toBe(false)
    })

    test('rejects in path context', () => {
      expect(hasWorkflowKeyword('src/workflow/index.ts')).toBe(false)
      expect(hasWorkflowKeyword('workflow.tsx')).toBe(false)
      expect(hasWorkflowKeyword('workflow-runner')).toBe(false)
    })

    test('rejects when followed by ?', () => {
      expect(hasWorkflowKeyword('what is workflow?')).toBe(false)
    })

    test('accepts at sentence end with period', () => {
      expect(hasWorkflowKeyword('please use a workflow.')).toBe(true)
    })

    test('accepts standalone', () => {
      expect(hasWorkflowKeyword('workflow')).toBe(true)
    })

    test('no match returns false', () => {
      expect(hasWorkflowKeyword('please do this task')).toBe(false)
    })
  })

  describe('findWorkflowTriggerPositions', () => {
    test('returns positions with correct offsets', () => {
      const positions = findWorkflowTriggerPositions('run a workflow here')
      expect(positions).toHaveLength(1)
      expect(positions[0]!.word).toBe('workflow')
      expect(positions[0]!.start).toBe(6)
      expect(positions[0]!.end).toBe(14)
    })

    test('finds multiple triggers', () => {
      const positions = findWorkflowTriggerPositions('workflow one and workflow two')
      expect(positions).toHaveLength(2)
    })
  })
})
