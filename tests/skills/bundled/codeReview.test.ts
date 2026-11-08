import { describe, expect, test } from 'bun:test'
import { buildCodeReviewPrompt } from '../../../src/skills/bundled/codeReview.js'

describe('codeReview', () => {
  test('默认包含所有本地改动且不修改或发布', () => {
    const prompt = buildCodeReviewPrompt('')
    expect(prompt).toContain('"target":null')
    expect(prompt).toContain('staged, unstaged, and untracked')
    expect(prompt).toContain('Do not modify files or apply fixes')
    expect(prompt).toContain('Do not send or post anything')
    expect(prompt).toContain('do not skip draft or automated PRs')
  })

  test.each([
    ['--base origin/main', 'base', 'origin/main'],
    ['--commit abc123', 'commit', 'abc123'],
    ['--pr 123', 'pr', '123'],
    ['#123', 'auto', '#123'],
    ['"src/path with spaces"', 'auto', 'src/path with spaces'],
    ['src/auth', 'auto', 'src/auth'],
  ])('解析目标 %s', (args, kind, target) => {
    expect(buildCodeReviewPrompt(args)).toContain(JSON.stringify({ kind, target }))
  })

  test('修改和发布必须显式指定', () => {
    const prompt = buildCodeReviewPrompt('--fix --pr 123 --comment')
    expect(prompt).toContain('apply verified fixes only in a checkout matching')
    expect(prompt).toContain('Recheck the PR head before posting')
    expect(prompt).not.toContain('Do not modify files or apply fixes')
  })

  test.each([
    '--base',
    '--base main --commit abc',
    '--unknown',
    '--comment',
    '--base main --comment',
    '"unclosed',
    "'unclosed",
    'main other',
  ])('拒绝错误参数 %s', (args) => {
    expect(buildCodeReviewPrompt(args)).toContain('Do not start a review')
  })
})
