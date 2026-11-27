/**
 * /feedback → GitHub issue 预填链接。
 *
 * 本模块只做纯计算：拼 issue 标题 / 正文 / 预填 URL，不发任何网络请求，
 * 也不读取会话记录。打开浏览器、调用 gh 由调用方决定。
 */
import { redactSensitiveInfo } from '../../utils/redactSensitiveInfo.js'

/** 反馈仓库（owner/repo）。与构建宏 MACRO.FEEDBACK_CHANNEL 指向同一个仓库。 */
export const FEEDBACK_REPO = 'ziyou979/zy-code'
export const FEEDBACK_ISSUES_URL = `https://github.com/${FEEDBACK_REPO}/issues`
export const FEEDBACK_ISSUE_LABELS = ['user-reported', 'bug'] as const

/**
 * 完整报告（含会话记录）的后端扩展点。
 *
 * 默认未设置 = 不发送任何内容：/feedback 目前只生成 GitHub issue 预填链接。
 * 以后接自建反馈服务时，在这里配置 endpoint，并在 Feedback 组件里加一个
 * 用户明确确认后才上传的步骤；不要在未设置时回退到任何默认地址。
 */
export const FEEDBACK_ENDPOINT: string | undefined = undefined

/** 实验得出的 GitHub new-issue URL 安全长度上限 */
export const GITHUB_URL_LIMIT = 7250
/** 预填正文里最多带几条近期报错 */
export const MAX_REPORTED_ERRORS = 10
/** 单条报错最长字符数（截断栈） */
const MAX_ERROR_CHARS = 2000
const MAX_TITLE_CHARS = 80
const FALLBACK_TITLE = 'Bug Report'

export type FeedbackEnvInfo = {
  version: string
  platform: string
  terminal: string | null
  isGit: boolean
}

export type FeedbackError = {
  error?: string
  timestamp?: string
}

/** 取最近 N 条报错并脱敏、截断；传入 homeDir 时把栈里的家目录路径替换成 ~ */
export function sanitizeErrors(
  errors: ReadonlyArray<FeedbackError>,
  limit: number = MAX_REPORTED_ERRORS,
  homeDir?: string,
): FeedbackError[] {
  return errors.slice(-limit).map((e) => {
    const copy: FeedbackError = { ...e }
    if (typeof copy.error === 'string') {
      let redacted = redactSensitiveInfo(copy.error)
      if (homeDir && homeDir.length > 1) {
        redacted = redacted.split(homeDir).join('~')
      }
      copy.error =
        redacted.length > MAX_ERROR_CHARS ? `${redacted.slice(0, MAX_ERROR_CHARS)}…` : redacted
    }
    return copy
  })
}

/** 无模型或模型失败时的标题：描述首行，按词边界截到 60 字以内 */
export function createFallbackTitle(description: string): string {
  const firstLine = (description.split('\n')[0] ?? '').trim()
  if (firstLine.length <= 60 && firstLine.length > 5) {
    return firstLine
  }
  let truncated = firstLine.slice(0, 60)
  if (firstLine.length > 60) {
    const lastSpace = truncated.lastIndexOf(' ')
    if (lastSpace > 30) {
      truncated = truncated.slice(0, lastSpace)
    }
    truncated += '...'
  }
  return truncated.length < 10 ? FALLBACK_TITLE : truncated
}

/** 清洗模型返回的标题：取首行、去引号、限长；不可用时返回 null */
export function normalizeGeneratedTitle(raw: string | null | undefined): string | null {
  if (!raw) {
    return null
  }
  let title = (raw.split('\n').find((l) => l.trim()) ?? '').trim()
  title = title.replace(/^["'`]+|["'`]+$/g, '').trim()
  if (!title) {
    return null
  }
  if (title.length > MAX_TITLE_CHARS) {
    title = `${title.slice(0, MAX_TITLE_CHARS - 1)}…`
  }
  return title
}

function buildBodyPrefix(description: string, envInfo: FeedbackEnvInfo): string {
  return (
    `**Bug Description**\n${redactSensitiveInfo(description)}\n\n` +
    `**Environment Info**\n` +
    `- Version: ${envInfo.version || 'unknown'}\n` +
    `- Platform: ${envInfo.platform}\n` +
    `- Terminal: ${envInfo.terminal ?? 'unknown'}\n` +
    `- Git repo: ${envInfo.isGit ? 'yes' : 'no'}\n` +
    `\n**Recent Errors**\n\`\`\`json\n`
  )
}
const BODY_SUFFIX = `\n\`\`\`\n`

/** 未截断的完整正文（给 gh issue create / 剪贴板用；已脱敏） */
export function buildIssueBody(
  description: string,
  envInfo: FeedbackEnvInfo,
  errors: ReadonlyArray<FeedbackError>,
): string {
  return (
    buildBodyPrefix(description, envInfo) + JSON.stringify(sanitizeErrors(errors)) + BODY_SUFFIX
  )
}

function isDecodable(encoded: string): boolean {
  try {
    decodeURIComponent(encoded)
    return true
  } catch {
    return false
  }
}

/**
 * 截断后回退到一个完整字符的边界：既不留下半个 %XX，
 * 也不留下多字节 UTF-8（中文、emoji）的半个字符。
 */
export function trimPartialEscape(encoded: string): string {
  let out = encoded
  const lastPercent = out.lastIndexOf('%')
  if (lastPercent !== -1 && lastPercent >= out.length - 2) {
    out = out.slice(0, lastPercent)
  }
  // 一个 UTF-8 字符最多 4 字节 = 12 个编码字符，回退次数有界
  while (out.length > 0 && !isDecodable(out)) {
    const p = out.lastIndexOf('%')
    out = p === -1 ? out.slice(0, -1) : out.slice(0, p)
  }
  return out
}

/**
 * 生成 {repo}/issues/new?title=&labels=&body= 预填链接，总长不超过 GITHUB_URL_LIMIT。
 * 优先保留描述与环境信息，超长时先截报错，再截整段正文。
 */
export function createGitHubIssueUrl(
  title: string,
  description: string,
  envInfo: FeedbackEnvInfo,
  errors: ReadonlyArray<FeedbackError>,
  issuesUrl: string = FEEDBACK_ISSUES_URL,
): string {
  const sanitizedTitle = redactSensitiveInfo(title)
  const bodyPrefix = buildBodyPrefix(description, envInfo)
  const errorsJson = JSON.stringify(sanitizeErrors(errors))
  const baseUrl =
    `${issuesUrl}/new?title=${encodeURIComponent(sanitizedTitle)}` +
    `&labels=${FEEDBACK_ISSUE_LABELS.join(',')}&body=`
  const truncationNote = `\n**Note:** Content was truncated.\n`
  const ellipsis = encodeURIComponent('…')
  const buffer = 50 // 额外安全余量
  const encodedPrefix = encodeURIComponent(bodyPrefix)
  const encodedSuffix = encodeURIComponent(BODY_SUFFIX)
  const encodedNote = encodeURIComponent(truncationNote)
  const encodedErrors = encodeURIComponent(errorsJson)

  const spaceForErrors =
    GITHUB_URL_LIMIT -
    baseUrl.length -
    encodedPrefix.length -
    encodedSuffix.length -
    encodedNote.length

  // 描述本身就超长：整体截断
  if (spaceForErrors <= 0) {
    const maxEncodedLength = Math.max(
      0,
      GITHUB_URL_LIMIT - baseUrl.length - ellipsis.length - encodedNote.length - buffer,
    )
    let encodedFullBody = encodeURIComponent(bodyPrefix + errorsJson + BODY_SUFFIX)
    if (encodedFullBody.length > maxEncodedLength) {
      encodedFullBody = trimPartialEscape(encodedFullBody.slice(0, maxEncodedLength))
    }
    return baseUrl + encodedFullBody + ellipsis + encodedNote
  }

  // 放得下：不截断
  if (encodedErrors.length <= spaceForErrors) {
    return baseUrl + encodedPrefix + encodedErrors + encodedSuffix
  }

  // 只截报错
  const truncatedErrors = trimPartialEscape(
    encodedErrors.slice(0, Math.max(0, spaceForErrors - ellipsis.length - buffer)),
  )
  return baseUrl + encodedPrefix + truncatedErrors + ellipsis + encodedSuffix + encodedNote
}
