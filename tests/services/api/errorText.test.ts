/**
 * API 错误文案：持久化英文 + 展示期按界面语言翻译（src/services/api/errorText.ts）。
 *
 * 守护三件事：
 *   1. errors.ts 的持久化常量与 locales 的 apiError.* 英文模板逐字一致（反查依赖它）；
 *   2. getAssistantMessageFromError 生成的 content 不随界面语言变化（会话回放 / 匹配依赖它）；
 *   3. localizeApiErrorText 在中英文下的展示结果，且上游原始错误正文原样保留。
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { getEnMessages, tEn, warmI18n } from '../../../src/i18n/index.js'
import { getLanguage, setLanguage } from '../../../src/i18n/languageStore.js'
import { setIsInteractive } from '../../../src/bootstrap/runtime/runtimeContext.js'
import {
  API_ERROR_MESSAGE_PREFIX,
  API_TIMEOUT_ERROR_MESSAGE,
  CCR_AUTH_ERROR_MESSAGE,
  CREDIT_BALANCE_TOO_LOW_ERROR_MESSAGE,
  CUSTOM_OFF_SWITCH_MESSAGE,
  getAssistantMessageFromError,
  getPdfTooLargeErrorMessage,
  INVALID_API_KEY_ERROR_MESSAGE_EXTERNAL,
  OAUTH_ORG_NOT_ALLOWED_ERROR_MESSAGE,
  ORG_DISABLED_ERROR_MESSAGE_ENV_KEY,
  ORG_DISABLED_ERROR_MESSAGE_ENV_KEY_WITH_OAUTH,
  PROMPT_TOO_LONG_ERROR_MESSAGE,
  REPEATED_529_ERROR_MESSAGE,
  startsWithApiErrorPrefix,
  TOKEN_REVOKED_ERROR_MESSAGE,
} from '../../../src/services/api/errors.js'
import {
  apiErrorText,
  localizeApiErrorText,
  matchApiErrorText,
} from '../../../src/services/api/errorText.js'

const originalLanguage = getLanguage()
afterEach(async () => {
  setLanguage(originalLanguage)
  setIsInteractive(true)
  await warmI18n()
})

function zh() {
  setLanguage('zh-CN')
}
function en() {
  setLanguage('en')
}

function makeAPIError(status: number, message: string): Error {
  const err = new Error(message)
  ;(err as Error & { status: number }).status = status
  return err
}

function contentOf(error: unknown): string {
  const msg = getAssistantMessageFromError(error, 'mock-model-1')
  const block = msg.message.content[0] as { type: string; text: string }
  return block.text
}

const UPSTREAM_401 =
  '401 {"type":"error","error":{"type":"authentication_error","message":"mock: invalid credentials"}}'

describe('持久化常量与 en 模板一致', () => {
  test.each([
    ['apiError.promptTooLong', PROMPT_TOO_LONG_ERROR_MESSAGE],
    ['apiError.creditBalanceTooLow', CREDIT_BALANCE_TOO_LOW_ERROR_MESSAGE],
    ['apiError.invalidApiKeyExternal', INVALID_API_KEY_ERROR_MESSAGE_EXTERNAL],
    ['apiError.orgDisabledEnvKeyWithOAuth', ORG_DISABLED_ERROR_MESSAGE_ENV_KEY_WITH_OAUTH],
    ['apiError.orgDisabledEnvKey', ORG_DISABLED_ERROR_MESSAGE_ENV_KEY],
    ['apiError.tokenRevoked', TOKEN_REVOKED_ERROR_MESSAGE],
    ['apiError.ccrAuth', CCR_AUTH_ERROR_MESSAGE],
    ['apiError.repeated529', REPEATED_529_ERROR_MESSAGE],
    ['apiError.customOffSwitch', CUSTOM_OFF_SWITCH_MESSAGE],
    ['apiError.timeout', API_TIMEOUT_ERROR_MESSAGE],
    ['apiError.oauthOrgNotAllowed', OAUTH_ORG_NOT_ALLOWED_ERROR_MESSAGE],
  ])('%s', (key, constant) => {
    expect(tEn(key)).toBe(constant)
  })

  test('"API Error: …" 模板都以 API_ERROR_MESSAGE_PREFIX 开头，startsWithApiErrorPrefix 仍能识别', () => {
    const en = getEnMessages()
    const prefixed = Object.entries(en).filter(
      ([k, v]) => k.startsWith('apiError.') && v.startsWith('API Error'),
    )
    expect(prefixed.length).toBeGreaterThan(8)
    for (const [, v] of prefixed) {
      expect(v.startsWith(`${API_ERROR_MESSAGE_PREFIX}:`)).toBe(true)
    }
    expect(startsWithApiErrorPrefix(tEn('apiError.authFailed.interactive', { detail: 'x' }))).toBe(
      true,
    )
  })
})

describe('getAssistantMessageFromError：content 固定为英文，与界面语言无关', () => {
  test('401（非交互）中英文界面下 content 逐字相同，且与改动前的字节一致', () => {
    setIsInteractive(false)
    en()
    const enContent = contentOf(makeAPIError(401, UPSTREAM_401))
    zh()
    const zhContent = contentOf(makeAPIError(401, UPSTREAM_401))
    expect(zhContent).toBe(enContent)
    expect(enContent).toBe(`Failed to authenticate. API Error: ${UPSTREAM_401}`)
  })

  test('401（交互）', () => {
    setIsInteractive(true)
    zh()
    expect(contentOf(makeAPIError(401, 'Unauthorized'))).toBe(
      'Please run /login · API Error: Unauthorized',
    )
  })

  test('404 模型不存在 / 通用 Error / 400', () => {
    setIsInteractive(false)
    zh()
    expect(contentOf(makeAPIError(404, 'not found'))).toBe(
      "There's an issue with the selected model (mock-model-1). It may not exist or you may not have access to it. Run --model to pick a different model.",
    )
    expect(contentOf(new Error('boom'))).toBe('API Error: boom')
    expect(contentOf(makeAPIError(400, '400 bad'))).toBe('API Error: 400 bad')
  })

  test('PDF 过大文案保留原有英文措辞（apiNormalize 的剥离表按它精确匹配）', () => {
    setIsInteractive(true)
    zh()
    expect(getPdfTooLargeErrorMessage()).toMatch(
      /^PDF too large \(max \d+ pages, .+\)\. Double press esc to go back and try again, or use pdftotext to convert to text first\.$/,
    )
  })
})

describe('localizeApiErrorText', () => {
  test('英文界面：原样返回', () => {
    en()
    const text = `Failed to authenticate. API Error: ${UPSTREAM_401}`
    expect(localizeApiErrorText(text)).toBe(text)
  })

  test('中文界面：401 只翻译我们拼的前缀，上游正文原样保留', () => {
    zh()
    expect(localizeApiErrorText(`Failed to authenticate. API Error: ${UPSTREAM_401}`)).toBe(
      `认证失败。API 错误：${UPSTREAM_401}`,
    )
    expect(localizeApiErrorText('Please run /login · API Error: Unauthorized')).toBe(
      '请运行 /login · API 错误：Unauthorized',
    )
  })

  test('中文界面：通用前缀 + 嵌套的自有文案递归翻译', () => {
    zh()
    expect(localizeApiErrorText(`API Error: ${REPEATED_529_ERROR_MESSAGE}`)).toBe(
      'API 错误：连续多次收到 529 过载错误',
    )
    expect(localizeApiErrorText('API Error: 400 {"error":{"message":"bad"}}')).toBe(
      'API 错误：400 {"error":{"message":"bad"}}',
    )
  })

  test('中文界面：常量、带插值模板、交互 / 非交互两套措辞', () => {
    zh()
    expect(localizeApiErrorText(API_TIMEOUT_ERROR_MESSAGE)).toBe('请求超时')
    expect(localizeApiErrorText(TOKEN_REVOKED_ERROR_MESSAGE)).toBe(
      'OAuth 令牌已被撤销 · 请运行 /login',
    )
    expect(
      localizeApiErrorText(
        apiErrorText('apiError.modelNotFound', { model: 'm1', switchCmd: '/model' }),
      ),
    ).toBe('所选模型（m1）有问题：可能不存在，或你没有访问权限。运行 /model 选择其他模型。')
    expect(
      localizeApiErrorText(apiErrorText('apiError.requestRejected429', { detail: 'slow down' })),
    ).toBe('API 错误：请求被拒绝（429）· slow down')
    expect(
      localizeApiErrorText(
        apiErrorText('apiError.pdfTooLarge.nonInteractive', { pages: 100, size: '20MB' }),
      ),
    ).toBe('PDF 过大（最多 100 页、20MB）。请换一种方式读取该文件（例如用 pdftotext 提取文本）。')
    expect(localizeApiErrorText(apiErrorText('apiError.maxOutputTokens', { max: 32000 }))).toBe(
      'API 错误：Zy 的回复超出了 32000 个输出 token 的上限。可通过环境变量 ZY_CODE_MAX_OUTPUT_TOKENS 调整。',
    )
  })

  test('中文界面：getAssistantMessageFromError 的 content 经展示层翻译', () => {
    setIsInteractive(false)
    zh()
    expect(localizeApiErrorText(contentOf(makeAPIError(401, UPSTREAM_401)))).toBe(
      `认证失败。API 错误：${UPSTREAM_401}`,
    )
  })

  test('不是我们生成的文本：原样返回', () => {
    zh()
    for (const text of ['Hello from the model', 'Request timed out.', 'API Error', '']) {
      expect(localizeApiErrorText(text)).toBe(text)
    }
  })

  test('反查优先最具体的模板', () => {
    expect(matchApiErrorText('Failed to authenticate. API Error: x')?.key).toBe(
      'apiError.authFailed.nonInteractive',
    )
    expect(matchApiErrorText('API Error: Request rejected (429) · y')).toEqual({
      key: 'apiError.requestRejected429',
      vars: { detail: 'y' },
    })
    expect(matchApiErrorText('API Error: multi\nline')).toEqual({
      key: 'apiError.generic',
      vars: { detail: 'multi\nline' },
    })
  })
})
