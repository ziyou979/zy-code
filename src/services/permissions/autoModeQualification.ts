import { createHash } from 'node:crypto'
import { z } from 'zod/v4'
import {
  getCachedAgentsMdContent,
  getAutoModeSessionGrant,
  getSessionId,
} from '../../bootstrap/runtime/runtimeContext.js'
import { toError } from '../../utils/errors.js'
import { resolveApiBaseUrl } from '../api/baseUrlResolution.js'
import { resolveModelRequestContext } from '../model/modelRequestContext.js'
import {
  getLocalModelCapability,
  getManualModelCapability,
} from '../settings/localModelCapabilities.js'
import {
  readModelCapabilityState,
  writeModelCapabilityState,
} from '../settings/modelCapabilityStorage.js'
import {
  getDiscoveredModelCapability,
  saveDiscoveredModelCapability,
} from '../settings/discoveredModelCapabilities.js'
import { getAutoModeConfig } from '../settings/settings.js'
import {
  AUTO_MODE_CLASSIFIER_SCHEMA_PROMPTS,
  buildDefaultSystemPrompt,
} from './classifierPrompt.js'
import {
  getTwoStageMode,
  isJsonlTranscriptEnabled,
  isTwoStageClassifierEnabled,
} from './classifierTranscript.js'
import {
  AUTO_MODE_EVALUATION_TTL_MS,
  AUTO_MODE_EVALUATION_VERSION,
  scoreAutoModeEvaluation,
  type AutoModeEvaluationObservation,
} from './autoModeEvaluation.js'

const ReportSchema = z.object({
  model: z.string(),
  fingerprint: z.string(),
  suiteVersion: z.number(),
  evaluatedAt: z.number(),
  observations: z.array(
    z.object({
      caseId: z.string(),
      repeat: z.number(),
      shouldBlock: z.boolean().optional(),
      valid: z.boolean(),
      durationMs: z.number().nonnegative(),
    }),
  ),
})
const DirectGrantSchema = z.object({
  model: z.string(),
  fingerprint: z.string(),
  grantedAt: z.number(),
})
const FileSchema = z.object({
  version: z.literal(1),
  reports: z.array(ReportSchema),
  directGrants: z.array(DirectGrantSchema).default([]),
})
export type AutoModeQualification = z.infer<typeof ReportSchema>

function readFile(): z.infer<typeof FileSchema> {
  return (
    readModelCapabilityState('qualification', FileSchema) ?? {
      version: 1,
      reports: [],
      directGrants: [],
    }
  )
}

/** 资格属于实际审批路由和应用策略，不能从目录的模型能力或智力分数导入。 */
export function getAutoModeQualificationFingerprint(model: string): string {
  const route = resolveModelRequestContext(model)
  const { provider, apiFormat } = route
  const connectionId = route.authProfile ?? provider
  const capability = getLocalModelCapability(model, { provider, connectionId, apiFormat })
  // 不存储凭证、工作区文案或私有端点。策略、端点、提示词变化会改变摘要。
  const settings = {
    model,
    provider,
    connectionId,
    apiFormat,
    endpoint: resolveApiBaseUrl({ context: route }),
    thinking: capability?.capabilities.thinking,
    maxOutputTokens: capability?.tokens?.maxOutputTokens,
    rules: getAutoModeConfig(),
    prompt: buildDefaultSystemPrompt(),
    schemaPrompts: AUTO_MODE_CLASSIFIER_SCHEMA_PROMPTS,
    agentsMd: getCachedAgentsMdContent(),
    cwd: process.cwd(),
    twoStage: isTwoStageClassifierEnabled() ? getTwoStageMode() : false,
    jsonl: isJsonlTranscriptEnabled(),
    suiteVersion: AUTO_MODE_EVALUATION_VERSION,
  }
  return createHash('sha256').update(JSON.stringify(settings)).digest('hex')
}

export function getAutoModeQualification(model: string): AutoModeQualification | undefined {
  try {
    const fingerprint = getAutoModeQualificationFingerprint(model)
    return readFile().reports.findLast(
      (report) => report.model === model && report.fingerprint === fingerprint,
    )
  } catch {
    return undefined
  }
}

export type AutoModeModelAuthorization =
  | 'verified'
  | 'direct'
  | 'temporary'
  | 'unverified'
  | 'disabled'

/** 用户直接授权与实测通过分开记录；两者都不意味着跳过危险命令审批。 */
export function getAutoModeModelAuthorization(model: string): AutoModeModelAuthorization {
  try {
    const route = resolveModelRequestContext(model)
    const capability = getLocalModelCapability(model, {
      provider: route.provider,
      connectionId: route.authProfile ?? route.provider,
      apiFormat: route.apiFormat,
    })
    if (capability?.capabilities.auto_mode === false) {
      return 'disabled'
    }
    const report = getAutoModeQualification(model)
    if (report?.suiteVersion === AUTO_MODE_EVALUATION_VERSION) {
      const age = Date.now() - report.evaluatedAt
      if (
        age >= 0 &&
        age < AUTO_MODE_EVALUATION_TTL_MS &&
        scoreAutoModeEvaluation(report.observations).passed
      ) {
        return 'verified'
      }
    }
    // 历史用户文件中的 true 是显式应用授权，不从自动模型目录导入此决定。
    if (
      (getDiscoveredModelCapability(
        model,
        {
          provider: route.provider,
          connectionId: route.authProfile ?? route.provider,
          apiFormat: route.apiFormat,
        },
        'user',
      )?.capabilities.auto_mode ??
        getManualModelCapability(model, { provider: route.provider, apiFormat: route.apiFormat })
          ?.capabilities.auto_mode) === true
    ) {
      return 'direct'
    }
    const fingerprint = getAutoModeQualificationFingerprint(model)
    if (
      readFile().directGrants.some(
        (grant) => grant.model === model && grant.fingerprint === fingerprint,
      )
    ) {
      return 'direct'
    }
    if (getTemporaryAutoModeAuthorizationId(model, fingerprint)) {
      return 'temporary'
    }
    return 'unverified'
  } catch {
    // 路由或配置不可解析时保持人工审批，不让资格检查阻塞正常对话。
    return 'unverified'
  }
}

export function isAutoModeModelEligible(model: string): boolean {
  const authorization = getAutoModeModelAuthorization(model)
  return authorization === 'verified' || authorization === 'direct' || authorization === 'temporary'
}

/** 仅用户界面确认调用；应用不得用模型输出伪造授权。 */
export function saveDirectAutoModeAuthorization(
  model: string,
  fingerprint: string,
): { error: Error | null } {
  try {
    if (
      getAutoModeModelAuthorization(model) === 'disabled' ||
      getAutoModeQualificationFingerprint(model) !== fingerprint
    ) {
      throw new Error('Auto mode authorization context changed')
    }
    const route = resolveModelRequestContext(model)
    const selection = {
      model,
      provider: route.provider,
      connectionId: route.authProfile ?? route.provider,
      apiFormat: route.apiFormat,
    }
    const previous = getDiscoveredModelCapability(model, selection, 'user')
    // 只追加当前连接的授权字段，不把自动目录能力复制成固定覆盖。
    return saveDiscoveredModelCapability(
      selection,
      {
        ...previous,
        capabilities: { ...previous?.capabilities, auto_mode: true },
      },
      'user',
    )
  } catch (error) {
    return { error: toError(error) }
  }
}

/** 只写用户目录、原子替换；中断或路由变化由调用方放弃保存，不产生新资格。 */
export function saveAutoModeQualification(
  model: string,
  fingerprint: string,
  observations: AutoModeEvaluationObservation[],
): { error: Error | null } {
  try {
    if (getAutoModeQualificationFingerprint(model) !== fingerprint) {
      throw new Error('Classifier configuration changed during evaluation')
    }
    const report = ReportSchema.parse({
      model,
      fingerprint,
      observations,
      suiteVersion: AUTO_MODE_EVALUATION_VERSION,
      evaluatedAt: Date.now(),
    })
    const file = readFile()
    file.reports = file.reports.filter((item) => item.fingerprint !== fingerprint)
    file.reports.push(report)
    return writeFile(file)
  } catch (error) {
    return { error: toError(error) }
  }
}

/** 资格与发现能力共用目录及原子写入，不维护第二处 IO 实现。 */
function writeFile(file: z.infer<typeof FileSchema>): { error: Error | null } {
  try {
    writeModelCapabilityState('qualification', file)
    return { error: null }
  } catch (error) {
    return { error: toError(error) }
  }
}

/** 每次开启都有独立令牌，关闭后重开也不能复用上一次在途审批。 */
export function getTemporaryAutoModeAuthorizationId(
  model: string,
  fingerprint = getAutoModeQualificationFingerprint(model),
): string | undefined {
  const grant = getAutoModeSessionGrant()
  return grant?.sessionId === getSessionId() &&
    grant.model === model &&
    grant.fingerprint === fingerprint
    ? grant.id
    : undefined
}
