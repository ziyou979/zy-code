import { tSync } from '../../i18n/index.js'
import { LLMError } from '../../types/llm.js'
import type {
  GoogleCandidate,
  GoogleGenerateContentResponse,
  GoogleUsageMetadata,
} from './conversions/google.js'

const usageKeys = [
  'promptTokenCount',
  'candidatesTokenCount',
  'thoughtsTokenCount',
  'cachedContentTokenCount',
  'totalTokenCount',
] as const

/** 每轮生成独享；请求内用量是累计快照，请求之间才求和。令牌只在内存中使用。 */
export class GoogleContinuationState {
  private readonly seenTokens = new Set<string>()
  private previousUsage: GoogleUsageMetadata = {}
  private segmentUsage: GoogleUsageMetadata = {}
  private initialPromptTokenCount: number | undefined

  constructor(private readonly maxOutputTokens: number) {}

  update(chunk: GoogleGenerateContentResponse): GoogleGenerateContentResponse {
    this.initialPromptTokenCount ??= chunk.initialPromptTokenCount
    if (!chunk.usageMetadata) {
      return chunk
    }
    this.segmentUsage = { ...this.segmentUsage, ...chunk.usageMetadata }
    this.initialPromptTokenCount ??=
      chunk.usageMetadata.initialPromptTokenCount ?? chunk.usageMetadata.promptTokenCount
    const usageMetadata: GoogleUsageMetadata = {
      initialPromptTokenCount: this.initialPromptTokenCount,
    }
    for (const key of usageKeys) {
      if (this.previousUsage[key] !== undefined || this.segmentUsage[key] !== undefined) {
        usageMetadata[key] = (this.previousUsage[key] ?? 0) + (this.segmentUsage[key] ?? 0)
      }
    }
    return { ...chunk, usageMetadata }
  }

  finish(candidate: GoogleCandidate | undefined): string | undefined {
    // MAX_TOKENS 即达到用户总预算；即使有令牌也不自动提额继续。
    if (candidate?.finishReason !== 'CONTINUATION') {
      return undefined
    }
    const token = candidate.continuationToken
    const output =
      (this.previousUsage.candidatesTokenCount ?? 0) +
      (this.segmentUsage.candidatesTokenCount ?? 0) +
      (this.previousUsage.thoughtsTokenCount ?? 0) +
      (this.segmentUsage.thoughtsTokenCount ?? 0)
    // 官方总预算至多 1M，非流式每段 32k；额外限制异常检查点，避免无限请求。
    if (
      !token ||
      this.seenTokens.has(token) ||
      this.seenTokens.size >= 64 ||
      output >= this.maxOutputTokens
    ) {
      throw new LLMError(tSync('google.invalidContinuation'), 400)
    }
    this.seenTokens.add(token)
    for (const key of usageKeys) {
      if (this.segmentUsage[key] !== undefined) {
        this.previousUsage[key] = (this.previousUsage[key] ?? 0) + this.segmentUsage[key]!
      }
    }
    this.segmentUsage = {}
    return token
  }
}
