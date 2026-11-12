import { describe, expect, test } from 'bun:test'
import {
  buildIssueBody,
  createFallbackTitle,
  createGitHubIssueUrl,
  FEEDBACK_ENDPOINT,
  FEEDBACK_ISSUES_URL,
  FEEDBACK_REPO,
  type FeedbackEnvInfo,
  GITHUB_URL_LIMIT,
  MAX_REPORTED_ERRORS,
  normalizeGeneratedTitle,
  sanitizeErrors,
  trimPartialEscape,
} from '../../../src/services/feedback/githubIssue.js'

const envInfo: FeedbackEnvInfo = {
  version: '1.2.3',
  platform: 'linux',
  terminal: 'xterm-256color',
  isGit: true,
}

function parse(url: string) {
  const u = new URL(url)
  return {
    origin: u.origin,
    path: u.pathname,
    title: u.searchParams.get('title'),
    labels: u.searchParams.get('labels'),
    body: u.searchParams.get('body') ?? '',
  }
}

describe('feedback 配置', () => {
  test('指向 ziyou979/zy-code，且默认不配置任何反馈后端', () => {
    expect(FEEDBACK_REPO).toBe('ziyou979/zy-code')
    expect(FEEDBACK_ISSUES_URL).toBe('https://github.com/ziyou979/zy-code/issues')
    expect(FEEDBACK_ENDPOINT).toBeUndefined()
  })
})

describe('createGitHubIssueUrl', () => {
  test('短报告：完整预填，不截断', () => {
    const url = createGitHubIssueUrl('[Bug] crash on /model', 'It crashes\nsecond line', envInfo, [
      { error: 'TypeError: x is undefined', timestamp: '2026-11-12T00:00:00Z' },
    ])
    const p = parse(url)
    expect(p.origin + p.path).toBe('https://github.com/ziyou979/zy-code/issues/new')
    expect(p.title).toBe('[Bug] crash on /model')
    expect(p.labels).toBe('user-reported,bug')
    expect(p.body).toContain('**Bug Description**\nIt crashes\nsecond line')
    expect(p.body).toContain('- Version: 1.2.3')
    expect(p.body).toContain('- Platform: linux')
    expect(p.body).toContain('- Terminal: xterm-256color')
    expect(p.body).toContain('- Git repo: yes')
    expect(p.body).toContain('TypeError: x is undefined')
    expect(p.body).not.toContain('truncated')
    expect(p.body).not.toContain('Feedback ID')
  })

  test('报错过多：只截报错，保留描述与环境信息，总长不超过上限', () => {
    const errors = Array.from({ length: 10 }, (_, i) => ({
      error: `Error ${i}: ${'x'.repeat(1500)}`,
      timestamp: 't',
    }))
    const url = createGitHubIssueUrl('title', 'short description', envInfo, errors)
    expect(url.length).toBeLessThanOrEqual(GITHUB_URL_LIMIT)
    const p = parse(url)
    expect(p.body).toContain('short description')
    expect(p.body).toContain('- Version: 1.2.3')
    expect(p.body).toContain('**Note:** Content was truncated.')
  })

  test('描述本身超长（含中文与 emoji）：整体截断，URL 仍可解码且不超上限', () => {
    const description = '中文描述🙂'.repeat(2000)
    const url = createGitHubIssueUrl('标题', description, envInfo, [])
    expect(url.length).toBeLessThanOrEqual(GITHUB_URL_LIMIT)
    expect(() => new URL(url).searchParams.get('body')).not.toThrow()
    const body = parse(url).body
    expect(body).toContain('**Note:** Content was truncated.')
    expect(body).not.toContain('\uFFFD')
  })

  test('标题、描述、报错都会脱敏', () => {
    const key = `sk-ant-api03-${'a'.repeat(30)}`
    const url = createGitHubIssueUrl(`fails with ${key}`, `my key is ${key}`, envInfo, [
      { error: `401 Authorization: Bearer abc.def.ghi with ${key}` },
    ])
    expect(decodeURIComponent(url)).not.toContain(key)
    expect(decodeURIComponent(url)).not.toContain('abc.def.ghi')
    expect(parse(url).title).toContain('[REDACTED_API_KEY]')
  })
})

describe('trimPartialEscape', () => {
  test('不留下半个 %XX 或半个 UTF-8 字符', () => {
    const enc = encodeURIComponent('ab中')
    for (let i = 0; i <= enc.length; i++) {
      const out = trimPartialEscape(enc.slice(0, i))
      expect(() => decodeURIComponent(out)).not.toThrow()
    }
    expect(trimPartialEscape(enc)).toBe(enc)
  })
})

describe('标题回退', () => {
  test('首行适中时直接用首行', () => {
    expect(createFallbackTitle('Crash when running /model\nmore')).toBe('Crash when running /model')
  })
  test('首行过长时按词边界截断并加省略号', () => {
    const t = createFallbackTitle(`${'word '.repeat(30)}end`)
    expect(t.endsWith('...')).toBe(true)
    expect(t.length).toBeLessThanOrEqual(63)
  })
  test('太短或为空时用 Bug Report', () => {
    expect(createFallbackTitle('')).toBe('Bug Report')
    expect(createFallbackTitle('bad')).toBe('Bug Report')
  })
  test('normalizeGeneratedTitle 取首行、去引号、限 80 字', () => {
    expect(normalizeGeneratedTitle('"[Bug] X"\nextra')).toBe('[Bug] X')
    expect(normalizeGeneratedTitle('   ')).toBeNull()
    expect(normalizeGeneratedTitle(null)).toBeNull()
    expect(normalizeGeneratedTitle('a'.repeat(200))?.length).toBe(80)
  })
})

describe('sanitizeErrors / buildIssueBody', () => {
  test(`只保留最近 ${MAX_REPORTED_ERRORS} 条并脱敏`, () => {
    const errors = Array.from({ length: 15 }, (_, i) => ({ error: `e${i} TOKEN=secret${i}` }))
    const out = sanitizeErrors(errors)
    expect(out).toHaveLength(MAX_REPORTED_ERRORS)
    expect(out[0]?.error).toBe('e5 TOKEN=[REDACTED]')
    expect(JSON.stringify(out)).not.toContain('secret')
  })
  test('完整正文不截断且不含会话记录字段', () => {
    const body = buildIssueBody('x'.repeat(10000), envInfo, [])
    expect(body).toContain('x'.repeat(10000))
    expect(body).not.toContain('transcript')
  })
})

describe('sanitizeErrors 家目录', () => {
  test('栈里的家目录路径替换为 ~', () => {
    const out = sanitizeErrors([{ error: 'at f (/home/alice/proj/a.js:1:2)' }], 10, '/home/alice')
    expect(out[0]?.error).toBe('at f (~/proj/a.js:1:2)')
  })
})
