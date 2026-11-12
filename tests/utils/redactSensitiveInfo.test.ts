import { describe, expect, test } from 'bun:test'
import { redactSensitiveInfo } from '../../src/utils/redactSensitiveInfo.js'

describe('redactSensitiveInfo', () => {
  test.each([
    ['Anthropic key', `key sk-ant-api03-${'A'.repeat(40)} end`, '[REDACTED_API_KEY]'],
    ['quoted Anthropic key', `"sk-ant-${'b'.repeat(30)}"`, '"[REDACTED_API_KEY]"'],
    ['OpenAI key', `OPENAI sk-proj-${'c'.repeat(40)}`, '[REDACTED_API_KEY]'],
    ['GitHub token', `ghp_${'d'.repeat(36)}`, '[REDACTED_GITHUB_TOKEN]'],
    ['AWS access key', 'AKIAABCDEFGHIJKLMNOP', '[REDACTED_AWS_KEY]'],
    ['GCP key', `AIza${'e'.repeat(35)}`, '[REDACTED_GCP_KEY]'],
    ['service account', 'svc@my-proj.iam.gserviceaccount.com', '[REDACTED_GCP_SERVICE_ACCOUNT]'],
    ['x-api-key header', '"x-api-key": "abc123"', '[REDACTED_API_KEY]'],
    ['bearer header', 'Authorization: Bearer abc.def', '[REDACTED_TOKEN]'],
    ['env assignment', 'MY_API_KEY=hunter2', '[REDACTED]'],
    ['password assignment', 'PASSWORD: hunter2', '[REDACTED]'],
  ])('%s', (_name, input, marker) => {
    const out = redactSensitiveInfo(input)
    expect(out).toContain(marker)
    expect(out).not.toContain('hunter2')
  })

  test('普通文本不变', () => {
    const text = 'TypeError: cannot read properties of undefined (reading "foo")\n中文描述'
    expect(redactSensitiveInfo(text)).toBe(text)
  })
})
