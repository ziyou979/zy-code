import { describe, expect, test } from 'bun:test'
import {
  parseMeta,
  validateScript,
  WorkflowScriptError,
} from '../../../src/tools/WorkflowTool/runtime/sandbox.js'

describe('WorkflowTool sandbox', () => {
  describe('parseMeta', () => {
    test('parses valid meta', () => {
      const source = `export const meta = {
  name: 'test-workflow',
  description: 'A test workflow',
  phases: [{ title: 'Phase 1', detail: 'Do stuff' }],
}
const result = await agent('hello')
`
      const meta = parseMeta(source)
      expect(meta.name).toBe('test-workflow')
      expect(meta.description).toBe('A test workflow')
      expect(meta.phases).toHaveLength(1)
      expect(meta.phases![0]!.title).toBe('Phase 1')
    })

    test('throws on missing meta', () => {
      expect(() => parseMeta('const x = 1')).toThrow(WorkflowScriptError)
    })

    test('throws on missing name', () => {
      const source = `export const meta = {
  description: 'no name'
}
`
      expect(() => parseMeta(source)).toThrow('meta.name is required')
    })

    test('throws on missing description', () => {
      const source = `export const meta = {
  name: 'foo'
}
`
      expect(() => parseMeta(source)).toThrow('meta.description is required')
    })

    test('rejects non-literal meta (function call)', () => {
      const source = `export const meta = getConfig()
`
      expect(() => parseMeta(source)).toThrow()
    })
  })

  describe('validateScript', () => {
    test('accepts normal script', () => {
      expect(() => validateScript('const x = 1')).not.toThrow()
    })

    test('rejects script exceeding byte limit', () => {
      const huge = 'x'.repeat(524289)
      expect(() => validateScript(huge)).toThrow('exceeds maximum size')
    })
  })
})
