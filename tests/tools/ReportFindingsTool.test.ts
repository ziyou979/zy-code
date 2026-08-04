import { describe, expect, test } from 'bun:test'
import { ReportFindingsTool } from '../../src/tools/ReportFindingsTool/ReportFindingsTool.js'

describe('ReportFindingsTool', () => {
  test('接受 Claude Code 的结构化 finding 形状', () => {
    const result = ReportFindingsTool.inputSchema.safeParse({
      level: 'high',
      findings: [
        {
          file: 'src/example.ts',
          line: 12,
          summary: 'Missing null guard',
          short_summary: 'Missing guard',
          failure_scenario: 'Calling with undefined throws before fallback.',
          category: 'correctness',
          verdict: 'CONFIRMED',
        },
      ],
    })
    expect(result.success).toBeTrue()
  })

  test('拒绝非 kebab-case category 和多余字段', () => {
    expect(
      ReportFindingsTool.inputSchema.safeParse({
        findings: [
          {
            file: 'src/example.ts',
            summary: 'Issue',
            failure_scenario: 'Scenario',
            category: 'Not Valid',
            extra: true,
          },
        ],
      }).success,
    ).toBeFalse()
  })
})
