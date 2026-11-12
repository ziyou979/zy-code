/**
 * API 错误文案：持久化用英文，展示时按当前界面语言翻译。
 *
 * 为什么不在生成时直接翻译：assistant 错误消息（createAssistantAPIErrorMessage）的
 * content 会写进会话 jsonl，并被多处按字符串识别 —— startsWithApiErrorPrefix、
 * isPromptTooLongMessage、apiNormalize 的媒体错误剥离表、AssistantTextMessage 的分支、
 * 错误分类的 includes 等。若按界面语言生成，切换语言或回放旧会话就会认不出来。
 *
 * 做法：
 *   - 生成：apiErrorText(key, vars) 固定取 en 模板（= 原英文字节，不随界面语言变）。
 *   - 展示：localizeApiErrorText(text) 用 en 的 apiError.* 模板反向匹配，抽出插值后
 *     按当前语言 tSync 重新渲染；名为 detail 的插值递归再匹配一次（内层可能也是我们
 *     自己的文案，如 "API Error: Repeated 529 Overloaded errors"）。匹配不到原样返回 ——
 *     上游 API 的原始错误正文永远原样保留。
 * 这些错误消息的 model 是 SYNTHETIC_MODEL，normalizeMessagesForAPI 不会把它们发给模型，
 * 因此展示层翻译不影响请求体。
 */
import { getEnMessages, getUiLanguage, tEn, tSync } from '../../i18n/index.js'

const KEY_PREFIX = 'apiError.'
/** 只是渲染辅助、不会出现在持久化内容里的 key，不参与反查 */
const RENDER_ONLY_KEYS = new Set([
  'apiError.contextLimitReached',
  'apiError.creditBalanceTooLowHint',
  'apiError.keychainLockedHint',
  'apiError.retrying_one',
  'apiError.retrying_other',
  'apiError.retryTimeoutHint',
  'apiError.timeoutHint',
  'apiError.waitAndRetry',
])
const MAX_DEPTH = 3

type Matcher = { key: string; re: RegExp; vars: string[]; literalLength: number }

let _matchers: Matcher[] | undefined
let _matchersSource: Record<string, string> | undefined

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function compileMatchers(): Matcher[] {
  const en = getEnMessages()
  if (_matchers && _matchersSource === en) {
    return _matchers
  }
  const out: Matcher[] = []
  for (const [key, template] of Object.entries(en)) {
    if (!key.startsWith(KEY_PREFIX) || RENDER_ONLY_KEYS.has(key)) {
      continue
    }
    const vars: string[] = []
    let pattern = ''
    let literalLength = 0
    let last = 0
    for (const m of template.matchAll(/\{(\w+)\}/g)) {
      const literal = template.slice(last, m.index)
      pattern += escapeRegExp(literal)
      literalLength += literal.length
      // 最后一个插值贪婪（吃掉剩余全部，含换行），中间的非贪婪
      pattern += '\u0000'
      vars.push(m[1]!)
      last = m.index! + m[0].length
    }
    const tail = template.slice(last)
    pattern += escapeRegExp(tail)
    literalLength += tail.length
    let seen = 0
    pattern = pattern.replace(/\u0000/g, () => (++seen === vars.length ? '([\\s\\S]*)' : '([\\s\\S]*?)'))
    out.push({ key, re: new RegExp(`^${pattern}$`), vars, literalLength })
  }
  // 字面量越长越具体，优先匹配（"Failed to authenticate. API Error: {detail}" 先于 "API Error: {detail}"）
  out.sort((a, b) => b.literalLength - a.literalLength || a.key.localeCompare(b.key))
  _matchers = out
  _matchersSource = en
  return out
}

/** 生成持久化用的英文错误文案（与界面语言无关）。 */
export function apiErrorText(key: string, vars?: Record<string, string | number>): string {
  return tEn(key, vars)
}

/** 反查：text 是哪条 apiError 模板生成的，以及插值是什么。 */
export function matchApiErrorText(
  text: string,
): { key: string; vars: Record<string, string> } | undefined {
  for (const m of compileMatchers()) {
    const hit = m.re.exec(text)
    if (!hit) {
      continue
    }
    const vars: Record<string, string> = {}
    m.vars.forEach((name, i) => {
      vars[name] = hit[i + 1] ?? ''
    })
    return { key: m.key, vars }
  }
  return undefined
}

function localize(text: string, depth: number): string {
  if (depth > MAX_DEPTH || !text) {
    return text
  }
  const hit = matchApiErrorText(text)
  if (!hit) {
    return text
  }
  const vars: Record<string, string> = {}
  for (const [name, value] of Object.entries(hit.vars)) {
    vars[name] = name === 'detail' ? localize(value, depth + 1) : value
  }
  return tSync(hit.key, vars)
}

/**
 * 把持久化的英文 API 错误文案翻译成当前界面语言（展示用）。
 * 不是我们生成的文案（上游原始错误、模型输出）原样返回。
 */
export function localizeApiErrorText(text: string): string {
  if (getUiLanguage() === 'en') {
    return text
  }
  return localize(text, 0)
}
