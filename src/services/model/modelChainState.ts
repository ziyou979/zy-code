/**
 * 多 auth 候选链的跨会话粘住状态。
 *
 * 写入 `~/.zy/model-chain-state.json`。当 settings 中 models / modelFailover
 * 指纹变化时保留候选身份，交由模型解析层按 provider/model/authProfile
 * 重新校验；用户 /model 或失效切换时更新 index。
 */

import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getZyConfigHomeDir } from '../../services/infra/envUtils.js'
import { getErrnoCode } from '../../utils/errors.js'
import {
  jsonParse,
  jsonStringify,
  writeFileSync_DEPRECATED,
} from '../../services/infra/slowOperations.js'
import type { SettingsJson } from '../settings/types.js'

export type ModelChainFailoverReason =
  | 'auth_failed'
  | 'rate_limit_exhausted'
  | 'quota_exhausted'
  | 'manual'
  | 'user_model'

export type ModelChainTierSticky = {
  index: number
  provider: string
  authProfile?: string
  model: string
  switchedAt: string
  reason?: ModelChainFailoverReason
}

type ModelChainStateFile = {
  version: 1
  configFingerprint: string
  tiers: Record<string, ModelChainTierSticky>
}

const STATE_VERSION = 1 as const

function getStatePath(): string {
  return join(getZyConfigHomeDir(), 'model-chain-state.json')
}

/** 对 models / providers.*.models / modelFailover 做稳定指纹 */
export function computeModelChainFingerprint(settings: SettingsJson | null | undefined): string {
  const payload = {
    models: settings?.models ?? null,
    modelFailover: settings?.modelFailover ?? null,
    providersModels: Object.fromEntries(
      Object.entries(settings?.providers ?? {}).map(([id, cfg]) => [
        id,
        {
          models: cfg?.models ?? null,
          mainLoopModel: cfg?.mainLoopModel ?? null,
          model: cfg?.model ?? null,
        },
      ]),
    ),
  }
  // 稳定序列化：按 key 排序避免插入序抖动
  const stable = stableStringify(payload)
  return createHash('sha256').update(stable).digest('hex')
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}

function readStateFile(): ModelChainStateFile | null {
  try {
    const raw = readFileSync(getStatePath(), 'utf-8')
    const parsed = jsonParse(raw) as ModelChainStateFile
    if (
      !parsed ||
      parsed.version !== STATE_VERSION ||
      typeof parsed.configFingerprint !== 'string' ||
      typeof parsed.tiers !== 'object' ||
      parsed.tiers === null
    ) {
      return null
    }
    return parsed
  } catch {
    return null
  }
}

function writeStateFile(state: ModelChainStateFile): void {
  const path = getStatePath()
  try {
    mkdirSync(dirname(path), { recursive: true })
  } catch (e: unknown) {
    if (getErrnoCode(e) !== 'EEXIST') {
      throw e
    }
  }
  writeFileSync_DEPRECATED(path, `${jsonStringify(state, null, 2)}\n`, {
    encoding: 'utf8',
    flush: false,
  })
  try {
    chmodSync(path, 0o600)
  } catch {
    // Windows 等可能不支持 chmod
  }
}

/**
 * 读取 sticky。配置指纹变化时保留候选身份并刷新指纹，模型解析层会
 * 按 provider/model/authProfile 校验它是否仍存在，避免仅因配置重排或
 * 增加其它候选就丢失用户通过 /model 做出的选择。
 */
export function getStickyForTier(
  tier: string,
  settings: SettingsJson | null | undefined,
): ModelChainTierSticky | null {
  const fingerprint = computeModelChainFingerprint(settings)
  const state = readStateFile()
  if (!state) {
    return null
  }
  if (state.configFingerprint !== fingerprint) {
    // 先保留候选身份；selectActiveCandidate 会负责重新定位或删除失效项。
    try {
      writeStateFile({ version: STATE_VERSION, configFingerprint: fingerprint, tiers: state.tiers })
    } catch {
      // 忽略写失败
    }
  }
  const sticky = state.tiers[tier]
  if (!sticky || typeof sticky.index !== 'number' || sticky.index < 0) {
    return null
  }
  return sticky
}

/** 仅删除一个已确认不再存在的档位选择，避免影响其它档位。 */
export function clearStickyForTier(tier: string, settings: SettingsJson | null | undefined): void {
  const fingerprint = computeModelChainFingerprint(settings)
  const prev = readStateFile()
  if (!prev || prev.configFingerprint !== fingerprint || !prev.tiers[tier]) {
    return
  }
  const tiers = { ...prev.tiers }
  delete tiers[tier]
  writeStateFile({ version: STATE_VERSION, configFingerprint: fingerprint, tiers })
}

/** 写入某档位 sticky（保留其它档位） */
export function setStickyForTier(
  tier: string,
  sticky: Omit<ModelChainTierSticky, 'switchedAt'> & { switchedAt?: string },
  settings: SettingsJson | null | undefined,
): void {
  const fingerprint = computeModelChainFingerprint(settings)
  const prev = readStateFile()
  const tiers =
    prev && prev.configFingerprint === fingerprint
      ? { ...prev.tiers }
      : ({} as Record<string, ModelChainTierSticky>)

  tiers[tier] = {
    index: sticky.index,
    provider: sticky.provider,
    authProfile: sticky.authProfile,
    model: sticky.model,
    reason: sticky.reason,
    switchedAt: sticky.switchedAt ?? new Date().toISOString(),
  }

  writeStateFile({
    version: STATE_VERSION,
    configFingerprint: fingerprint,
    tiers,
  })
}

/** 清空全部 sticky（配置变更或用户显式重置） */
export function clearAllModelChainSticky(settings?: SettingsJson | null): void {
  const fingerprint = settings
    ? computeModelChainFingerprint(settings)
    : computeModelChainFingerprint(null)
  writeStateFile({
    version: STATE_VERSION,
    configFingerprint: fingerprint,
    tiers: {},
  })
}

/** 读取 modelFailover 默认值 */
export function getModelFailoverConfig(settings: SettingsJson | null | undefined): {
  enabled: boolean
  maxConsecutiveFailures: number
} {
  const raw = settings?.modelFailover
  return {
    enabled: raw?.enabled !== false,
    maxConsecutiveFailures:
      typeof raw?.maxConsecutiveFailures === 'number' && raw.maxConsecutiveFailures >= 1
        ? Math.min(10, Math.floor(raw.maxConsecutiveFailures))
        : 2,
  }
}
