import type { QuerySource } from '../../constants/querySource.js'
import type { AssistantMessage } from '../../types/message.js'
import { queryCompactModel } from '../api/compactQueries.js'
import { startsWithApiErrorPrefix } from '../api/errors.js'
import { asSystemPrompt } from '../api/systemPromptType.js'
import { logForDebugging } from '../infra/debug.js'
import { getDefaultCompactModel } from '../model/model.js'
import { createFallbackTitle, normalizeGeneratedTitle } from './githubIssue.js'
import { redactSensitiveInfo } from '../../utils/redactSensitiveInfo.js'

/** 模型生成标题的最长等待时间；超时直接用回退标题 */
const TITLE_TIMEOUT_MS = 15_000

const TITLE_SYSTEM_PROMPT = [
  'Generate a concise, technical issue title (max 80 chars) for a public GitHub issue based on this bug report for ZY Code.',
  'ZY Code is an agentic coding CLI.',
  'The title should:',
  '- Start with the type of issue, [Bug] or [Feature Request]',
  '- Be concise, specific and descriptive of the actual problem',
  '- For error messages, extract the key error rather than the full message',
  '- If you cannot determine a clear issue, use "Bug Report: [brief description]"',
  '- Use the same language as the bug report',
  'Reply with the title only, no other commentary.',
]

export type TitleDeps = {
  hasCompactModel: () => boolean
  query: (description: string, signal: AbortSignal) => Promise<string | null>
}

async function queryTitle(description: string, signal: AbortSignal): Promise<string | null> {
  const response = await queryCompactModel({
    systemPrompt: asSystemPrompt(TITLE_SYSTEM_PROMPT),
    userPrompt: description,
    signal,
    options: {
      hasAppendSystemPrompt: false,
      toolChoice: undefined,
      isNonInteractiveSession: false,
      agents: [],
      querySource: 'feedback' as QuerySource,
      mcpTools: [],
    },
  })
  return extractTitleText(response)
}

/**
 * 从模型回复里取标题文本。失败的请求不会抛错，而是返回一条 isApiErrorMessage 的
 * 助手消息（如 "Request timed out"），这种情况返回 null，交给回退标题。
 */
export function extractTitleText(
  response: Pick<AssistantMessage, 'isApiErrorMessage' | 'error' | 'message'>,
): string | null {
  if (response.isApiErrorMessage || response.error) {
    return null
  }
  const first = response.message.content[0]
  return first && first.type === 'text' ? first.text : null
}

const defaultDeps: TitleDeps = {
  hasCompactModel: () => Boolean(getDefaultCompactModel()),
  query: queryTitle,
}

/**
 * 生成 issue 标题。配置了 compact 模型时尝试用模型生成（发给用户自己配置的模型服务，
 * 内容为已脱敏的描述）；未配置、超时、出错或返回 API 错误时回退为描述首行截断。
 * 永不抛错。
 */
export async function generateFeedbackTitle(
  description: string,
  abortSignal: AbortSignal,
  deps: TitleDeps = defaultDeps,
): Promise<{ title: string; source: 'model' | 'fallback' }> {
  const fallback = {
    title: createFallbackTitle(redactSensitiveInfo(description)),
    source: 'fallback' as const,
  }
  if (!description.trim()) {
    return fallback
  }
  try {
    if (!deps.hasCompactModel()) {
      return fallback
    }
  } catch {
    return fallback
  }
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  abortSignal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), TITLE_TIMEOUT_MS)
  try {
    const raw = await deps.query(redactSensitiveInfo(description), controller.signal)
    const title = normalizeGeneratedTitle(raw)
    if (!title || startsWithApiErrorPrefix(title)) {
      return fallback
    }
    return { title, source: 'model' }
  } catch (error) {
    logForDebugging(`feedback title generation failed, using fallback: ${String(error)}`)
    return fallback
  } finally {
    clearTimeout(timer)
    abortSignal.removeEventListener('abort', onAbort)
  }
}
