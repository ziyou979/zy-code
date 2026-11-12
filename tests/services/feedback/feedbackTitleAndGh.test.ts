import { describe, expect, test } from 'bun:test'
import {
  extractTitleText,
  generateFeedbackTitle,
} from '../../../src/services/feedback/feedbackTitle.js'
import { buildGhIssueArgs, createIssueWithGh } from '../../../src/services/feedback/ghIssue.js'

const signal = new AbortController().signal

describe('generateFeedbackTitle', () => {
  test('未配置 compact 模型：不调用模型，回退为描述首行', async () => {
    let called = false
    const r = await generateFeedbackTitle('Crash when running /model\nmore', signal, {
      hasCompactModel: () => false,
      query: async () => {
        called = true
        return 'x'
      },
    })
    expect(called).toBe(false)
    expect(r).toEqual({ title: 'Crash when running /model', source: 'fallback' })
  })

  test('模型可用：使用模型标题，且发给模型的描述已脱敏', async () => {
    let sent = ''
    const key = `sk-ant-${'z'.repeat(30)}`
    const r = await generateFeedbackTitle(`Auth fails with ${key}`, signal, {
      hasCompactModel: () => true,
      query: async (d) => {
        sent = d
        return '[Bug] Auth fails\n'
      },
    })
    expect(r).toEqual({ title: '[Bug] Auth fails', source: 'model' })
    expect(sent).not.toContain(key)
  })

  test('模型抛错 / 返回 API 错误 / 返回空：回退，不抛', async () => {
    const desc = 'Something broke badly here'
    for (const query of [
      async () => {
        throw new Error('no provider')
      },
      async () => 'API Error: 500 boom',
      async () => '',
    ]) {
      const r = await generateFeedbackTitle(desc, signal, { hasCompactModel: () => true, query })
      expect(r).toEqual({ title: desc, source: 'fallback' })
    }
  })

  test('判断模型配置本身出错也回退', async () => {
    const r = await generateFeedbackTitle('Something broke badly here', signal, {
      hasCompactModel: () => {
        throw new Error('settings not loaded')
      },
      query: async () => 'x',
    })
    expect(r.source).toBe('fallback')
  })
})

describe('extractTitleText', () => {
  test('正常回复取首个文本块', () => {
    const msg = { message: { content: [{ type: 'text', text: '[Bug] X' }] } }
    expect(extractTitleText(msg as never)).toBe('[Bug] X')
  })
  test('API 错误消息（如超时）不当作标题', () => {
    const msg = {
      isApiErrorMessage: true,
      message: { content: [{ type: 'text', text: 'Request timed out' }] },
    }
    expect(extractTitleText(msg as never)).toBeNull()
  })
})

describe('createIssueWithGh', () => {
  test('参数：--repo ziyou979/zy-code，正文走 stdin，带 labels', () => {
    expect(buildGhIssueArgs('t', true)).toEqual([
      'issue',
      'create',
      '--repo',
      'ziyou979/zy-code',
      '--title',
      't',
      '--body-file',
      '-',
      '--label',
      'user-reported,bug',
    ])
  })

  test('成功时解析 issue URL，正文已脱敏', async () => {
    const calls: Array<{ args: string[]; input: string }> = []
    const r = await createIssueWithGh('t', 'body TOKEN=abc', async (_f, args, input) => {
      calls.push({ args, input })
      return { code: 0, stdout: 'https://github.com/ziyou979/zy-code/issues/42\n', stderr: '' }
    })
    expect(r).toEqual({ ok: true, url: 'https://github.com/ziyou979/zy-code/issues/42' })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.input).toBe('body TOKEN=[REDACTED]')
  })

  test('label 不存在时去掉 label 重试一次', async () => {
    const calls: string[][] = []
    const r = await createIssueWithGh('t', 'b', async (_f, args) => {
      calls.push(args)
      if (args.includes('--label')) {
        return { code: 1, stdout: '', stderr: "could not add label: 'user-reported' not found" }
      }
      return { code: 0, stdout: 'https://github.com/ziyou979/zy-code/issues/7', stderr: '' }
    })
    expect(r.ok).toBe(true)
    expect(calls).toHaveLength(2)
    expect(calls[1]).not.toContain('--label')
  })

  test('其他失败返回错误信息', async () => {
    const r = await createIssueWithGh('t', 'b', async () => ({
      code: 1,
      stdout: '',
      stderr: 'HTTP 401: Bad credentials',
    }))
    expect(r).toEqual({ ok: false, error: 'HTTP 401: Bad credentials' })
  })
})

describe('回退标题脱敏', () => {
  test('回退标题从脱敏后的描述生成，截断不会留下半截 key', async () => {
    const key = `sk-ant-api03-${'K'.repeat(40)}`
    const r = await generateFeedbackTitle(`Auth fails ${key}`, signal, {
      hasCompactModel: () => false,
      query: async () => null,
    })
    expect(r.title).not.toContain('KKKK')
    expect(r.title).toContain('[REDACTED_API_KEY]')
  })
})
