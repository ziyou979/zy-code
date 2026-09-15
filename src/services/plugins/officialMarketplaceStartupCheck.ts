/**
 * Auto-install logic for the official Anthropic marketplace.
 *
 * This module handles automatically installing the official marketplace
 * on startup for new users, with appropriate checks for:
 * - Enterprise policy restrictions
 * - Git availability
 * - Previous installation attempts
 */

import { join } from 'node:path'
import { logForDebugging } from '../../services/infra/debug.js'
import { isEnvTruthy } from '../../services/infra/envUtils.js'
import { errorMessage, toError } from '../../utils/errors.js'
import { logError } from '../../services/infra/log.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'
import { logEvent } from '../analytics/index.js'
import { getGlobalConfig, saveGlobalConfig } from '../config/config.js'
import { checkGitAvailable, markGitUnavailable } from './gitAvailability.js'
import { isSourceAllowedByPolicy } from './marketplaceHelpers.js'
import {
  addMarketplaceSource,
  getMarketplacesCacheDir,
  loadKnownMarketplacesConfig,
  saveKnownMarketplacesConfig,
} from './marketplaceManager.js'
import { OFFICIAL_MARKETPLACE_NAME, OFFICIAL_MARKETPLACE_SOURCE } from './officialMarketplace.js'
import { fetchOfficialMarketplaceFromGcs } from './officialMarketplaceGcs.js'

/**
 * Reason why the official marketplace was not installed
 */
export type OfficialMarketplaceSkipReason =
  | 'already_attempted'
  | 'already_installed'
  | 'policy_blocked'
  | 'git_unavailable'
  | 'gcs_unavailable'
  | 'unknown'

/**
 * Check if official marketplace auto-install is disabled via environment variable.
 */
export function isOfficialMarketplaceAutoInstallDisabled(): boolean {
  return isEnvTruthy(process.env.ZY_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL)
}

/**
 * Configuration for retry logic
 */
export const RETRY_CONFIG = {
  MAX_ATTEMPTS: 10,
  INITIAL_DELAY_MS: 60 * 60 * 1000, // 1 hour
  BACKOFF_MULTIPLIER: 2,
  MAX_DELAY_MS: 7 * 24 * 60 * 60 * 1000, // 1 week
}

/**
 * Calculate next retry delay using exponential backoff
 */
function calculateNextRetryDelay(retryCount: number): number {
  const delay = RETRY_CONFIG.INITIAL_DELAY_MS * RETRY_CONFIG.BACKOFF_MULTIPLIER ** retryCount
  return Math.min(delay, RETRY_CONFIG.MAX_DELAY_MS)
}

/**
 * 判断自动安装重试预算是否已耗尽。
 *
 * 与 `shouldRetryInstallation` 内的短路检查保持一致：一旦耗尽，git clone
 * 不再自动重试（避免每次启动都发起重量级克隆拖垮网络/磁盘）；但允许
 * 一次轻量的 GCS 镜像恢复尝试，防止旧版本累积的失败计数把安装永久锁死
 * （例如 9/7 修复指向 Claude 官方源后，7 月烧完的 10 次预算会跳过新代码）。
 */
// 参数收窄为实际读取的两个字段：既兼容调用方传入完整 GlobalConfig，
// 也让测试可以只构造相关字段（Partial 结构可赋值）
export function isRetryBudgetExhausted(config: {
  officialMarketplaceAutoInstalled?: boolean
  officialMarketplaceAutoInstallRetryCount?: number
}): boolean {
  return (
    !config.officialMarketplaceAutoInstalled &&
    (config.officialMarketplaceAutoInstallRetryCount || 0) >= RETRY_CONFIG.MAX_ATTEMPTS
  )
}

/**
 * Determine if installation should be retried based on failure reason and retry state
 */
function shouldRetryInstallation(config: ReturnType<typeof getGlobalConfig>): boolean {
  // If never attempted, should try
  if (!config.officialMarketplaceAutoInstallAttempted) {
    return true
  }

  // If already installed successfully, don't retry
  if (config.officialMarketplaceAutoInstalled) {
    return false
  }

  const failReason = config.officialMarketplaceAutoInstallFailReason
  const nextRetryTime = config.officialMarketplaceAutoInstallNextRetryTime
  const now = Date.now()

  // Check if we've exceeded max attempts
  if (isRetryBudgetExhausted(config)) {
    return false
  }

  // Permanent failures - don't retry
  if (failReason === 'policy_blocked') {
    return false
  }

  // Check if enough time has passed for next retry
  if (nextRetryTime && now < nextRetryTime) {
    return false
  }

  // Retry for temporary failures (unknown), semi-permanent (git_unavailable),
  // and legacy state (undefined failReason from before retry logic existed)
  return (
    failReason === 'unknown' ||
    failReason === 'git_unavailable' ||
    failReason === 'gcs_unavailable' ||
    failReason === undefined
  )
}

/**
 * 将官方 marketplace 标记为已安装，并清理指数退避的重试元数据。
 * 主路径的 GCS/git 成功分支与恢复路径共用，避免重复写 6 个字段的样板代码。
 */
function markAutoInstalledSuccess(): void {
  saveGlobalConfig((current) => ({
    ...current,
    officialMarketplaceAutoInstallAttempted: true,
    officialMarketplaceAutoInstalled: true,
    officialMarketplaceAutoInstallFailReason: undefined,
    officialMarketplaceAutoInstallRetryCount: undefined,
    officialMarketplaceAutoInstallLastAttemptTime: undefined,
    officialMarketplaceAutoInstallNextRetryTime: undefined,
  }))
}

/**
 * 从 GCS 镜像拉取并注册官方 marketplace。
 * 成功返回 SHA 并已写入 `known_marketplaces.json`；失败（网络/404/解压）
 * 返回 null，交由调用方决定是否回退或走恢复路径。
 */
async function installOfficialMarketplaceViaGcs(): Promise<string | null> {
  const cacheDir = getMarketplacesCacheDir()
  const installLocation = join(cacheDir, OFFICIAL_MARKETPLACE_NAME)
  const gcsSha = await fetchOfficialMarketplaceFromGcs(installLocation, cacheDir)
  if (gcsSha === null) {
    return null
  }
  const known = await loadKnownMarketplacesConfig()
  known[OFFICIAL_MARKETPLACE_NAME] = {
    source: OFFICIAL_MARKETPLACE_SOURCE,
    installLocation,
    lastUpdated: new Date().toISOString(),
  }
  await saveKnownMarketplacesConfig(known)
  return gcsSha
}

/**
 * Result of the auto-install check
 */
export type OfficialMarketplaceCheckResult = {
  /** Whether the marketplace was successfully installed */
  installed: boolean
  /** Whether the installation was skipped (and why) */
  skipped: boolean
  /** Reason for skipping, if applicable */
  reason?: OfficialMarketplaceSkipReason
  /** Whether saving retry metadata to config failed */
  configSaveFailed?: boolean
}

/**
 * 重试预算耗尽后的 GCS-only 恢复尝试。
 *
 * git 克隆的指数退避预算封顶后不再自动重开，但仍允许一次轻量的 GCS 镜像
 * 探测：它只有 40 字节的 latest 指针 + sentinel 比对，幂等且设计上就是每次
 * 启动可重复调用的。成功则安装并清空重试元数据；失败则保持静默（返回
 * gcs_unavailable，不触发失败通知，也不再累加计数），下次启动继续尝试。
 *
 * 该函数完全自包含、不向外抛出，避免把恢复路径的磁盘/IO 异常混进主路径的
 * 失败计数逻辑（那会误触发一次“安装失败”通知）。
 */
async function attemptGcsOnlyRecovery(
  config: ReturnType<typeof getGlobalConfig>,
): Promise<OfficialMarketplaceCheckResult> {
  try {
    // 恢复路径同样受 env kill switch 与企业策略约束
    if (isOfficialMarketplaceAutoInstallDisabled()) {
      logForDebugging('Official marketplace auto-install disabled via env var (recovery), skipping')
      saveGlobalConfig((current) => ({
        ...current,
        officialMarketplaceAutoInstallFailReason: 'policy_blocked',
      }))
      return { installed: false, skipped: true, reason: 'policy_blocked' }
    }
    if (!isSourceAllowedByPolicy(OFFICIAL_MARKETPLACE_SOURCE)) {
      logForDebugging('Official marketplace blocked by enterprise policy (recovery), skipping')
      saveGlobalConfig((current) => ({
        ...current,
        officialMarketplaceAutoInstallFailReason: 'policy_blocked',
      }))
      return { installed: false, skipped: true, reason: 'policy_blocked' }
    }

    // 已被其他路径注册（如用户手动 `/plugin marketplace add`）：补齐状态即可，不再拉取
    const knownMarketplaces = await loadKnownMarketplacesConfig()
    if (knownMarketplaces[OFFICIAL_MARKETPLACE_NAME]) {
      logForDebugging(
        `Official marketplace '${OFFICIAL_MARKETPLACE_NAME}' already installed (recovery), marking installed`,
      )
      markAutoInstalledSuccess()
      return { installed: false, skipped: true, reason: 'already_installed' }
    }

    const gcsSha = await installOfficialMarketplaceViaGcs()
    if (gcsSha === null) {
      logForDebugging(
        'Official marketplace recovery via GCS failed; will retry next startup (no backoff increment)',
      )
      logEvent('zy_official_marketplace_auto_install', {
        installed: false,
        skipped: true,
        gcs_unavailable: true,
        // 计数封顶：沿用当前值（至少 MAX_ATTEMPTS），不再累加
        retry_count: config.officialMarketplaceAutoInstallRetryCount || RETRY_CONFIG.MAX_ATTEMPTS,
      })
      return { installed: false, skipped: true, reason: 'gcs_unavailable' }
    }

    logForDebugging(
      'Successfully recovered official marketplace via GCS after retry budget exhausted',
    )
    markAutoInstalledSuccess()
    logEvent('zy_official_marketplace_auto_install', {
      installed: true,
      skipped: false,
      via_gcs: true,
    })
    return { installed: true, skipped: false }
  } catch (recoveryError) {
    // 磁盘/IO 异常：保持静默、不累加计数、下次启动继续尝试
    logForDebugging(
      `Official marketplace recovery failed unexpectedly: ${errorMessage(recoveryError)}`,
      { level: 'warn' },
    )
    return { installed: false, skipped: true, reason: 'gcs_unavailable' }
  }
}

/**
 * Check and install the official marketplace on startup.
 *
 * This function is designed to be called as a fire-and-forget operation
 * during startup. It will:
 * 1. Check if installation was already attempted
 * 2. Check if marketplace is already installed
 * 3. Check enterprise policy restrictions
 * 4. Check git availability
 * 5. Attempt installation
 * 6. Record the result in GlobalConfig
 *
 * @returns Result indicating whether installation succeeded or was skipped
 */
export async function checkAndInstallOfficialMarketplace(): Promise<OfficialMarketplaceCheckResult> {
  const config = getGlobalConfig()

  // Check if we should retry installation
  if (!shouldRetryInstallation(config)) {
    const reason: OfficialMarketplaceSkipReason =
      config.officialMarketplaceAutoInstallFailReason ?? 'already_attempted'
    // 重试预算耗尽且非策略阻断：退而求其次走一次 GCS 恢复尝试。预算封顶只应
    // 封住重量级的 git 克隆重试，不应把轻量幂等的 GCS 探测一起永久锁死——
    // 否则历史失败计数会吞掉后续修复（如源指向变更、网络恢复）。
    if (isRetryBudgetExhausted(config) && reason !== 'policy_blocked') {
      return await attemptGcsOnlyRecovery(config)
    }
    logForDebugging(`Official marketplace auto-install skipped: ${reason}`)
    return {
      installed: false,
      skipped: true,
      reason,
    }
  }

  try {
    // Check if auto-install is disabled via env var
    if (isOfficialMarketplaceAutoInstallDisabled()) {
      logForDebugging('Official marketplace auto-install disabled via env var, skipping')
      saveGlobalConfig((current) => ({
        ...current,
        officialMarketplaceAutoInstallAttempted: true,
        officialMarketplaceAutoInstalled: false,
        officialMarketplaceAutoInstallFailReason: 'policy_blocked',
      }))
      logEvent('zy_official_marketplace_auto_install', {
        installed: false,
        skipped: true,
        policy_blocked: true,
      })
      return { installed: false, skipped: true, reason: 'policy_blocked' }
    }

    // Check if marketplace is already installed
    const knownMarketplaces = await loadKnownMarketplacesConfig()
    if (knownMarketplaces[OFFICIAL_MARKETPLACE_NAME]) {
      logForDebugging(
        `Official marketplace '${OFFICIAL_MARKETPLACE_NAME}' already installed, skipping`,
      )
      // Mark as installed & clear retry metadata so we don't check again
      markAutoInstalledSuccess()
      return { installed: false, skipped: true, reason: 'already_installed' }
    }

    // Check enterprise policy restrictions
    if (!isSourceAllowedByPolicy(OFFICIAL_MARKETPLACE_SOURCE)) {
      logForDebugging('Official marketplace blocked by enterprise policy, skipping')
      saveGlobalConfig((current) => ({
        ...current,
        officialMarketplaceAutoInstallAttempted: true,
        officialMarketplaceAutoInstalled: false,
        officialMarketplaceAutoInstallFailReason: 'policy_blocked',
      }))
      logEvent('zy_official_marketplace_auto_install', {
        installed: false,
        skipped: true,
        policy_blocked: true,
      })
      return { installed: false, skipped: true, reason: 'policy_blocked' }
    }

    // inc-5046: try GCS mirror first — doesn't need git, doesn't hit GitHub.
    // Backend (anthropic#317037) publishes a marketplace zip to the same
    // bucket as the native binary. If GCS succeeds, register the marketplace
    // with source:'github' (still true — GCS is a mirror) and skip git
    // entirely.
    const gcsSha = await installOfficialMarketplaceViaGcs()
    if (gcsSha !== null) {
      markAutoInstalledSuccess()
      logEvent('zy_official_marketplace_auto_install', {
        installed: true,
        skipped: false,
        via_gcs: true,
      })
      return { installed: true, skipped: false }
    }
    // GCS failed (404 until backend writes, or network). Fall through to git
    // ONLY if the kill-switch allows — same gate as refreshMarketplace().
    if (!getFeatureValue_CACHED_MAY_BE_STALE('zy_plugin_official_mkt_git_fallback', true)) {
      logForDebugging(
        'Official marketplace GCS failed; git fallback disabled by flag — skipping install',
      )
      // Same retry-with-backoff metadata as git_unavailable below — transient
      // GCS failures should retry with exponential backoff, not give up.
      const retryCount = (config.officialMarketplaceAutoInstallRetryCount || 0) + 1
      const now = Date.now()
      const nextRetryTime = now + calculateNextRetryDelay(retryCount)
      saveGlobalConfig((current) => ({
        ...current,
        officialMarketplaceAutoInstallAttempted: true,
        officialMarketplaceAutoInstalled: false,
        officialMarketplaceAutoInstallFailReason: 'gcs_unavailable',
        officialMarketplaceAutoInstallRetryCount: retryCount,
        officialMarketplaceAutoInstallLastAttemptTime: now,
        officialMarketplaceAutoInstallNextRetryTime: nextRetryTime,
      }))
      logEvent('zy_official_marketplace_auto_install', {
        installed: false,
        skipped: true,
        gcs_unavailable: true,
        retry_count: retryCount,
      })
      return { installed: false, skipped: true, reason: 'gcs_unavailable' }
    }

    // Check git availability
    const gitAvailable = await checkGitAvailable()
    if (!gitAvailable) {
      logForDebugging('Git not available, skipping official marketplace auto-install')
      const retryCount = (config.officialMarketplaceAutoInstallRetryCount || 0) + 1
      const now = Date.now()
      const nextRetryDelay = calculateNextRetryDelay(retryCount)
      const nextRetryTime = now + nextRetryDelay

      let configSaveFailed = false
      try {
        saveGlobalConfig((current) => ({
          ...current,
          officialMarketplaceAutoInstallAttempted: true,
          officialMarketplaceAutoInstalled: false,
          officialMarketplaceAutoInstallFailReason: 'git_unavailable',
          officialMarketplaceAutoInstallRetryCount: retryCount,
          officialMarketplaceAutoInstallLastAttemptTime: now,
          officialMarketplaceAutoInstallNextRetryTime: nextRetryTime,
        }))
      } catch (saveError) {
        configSaveFailed = true
        // Log the error properly so it gets tracked
        const configError = toError(saveError)
        logError(configError)

        logForDebugging(
          `Failed to save marketplace auto-install git_unavailable state: ${saveError}`,
          { level: 'error' },
        )
      }
      logEvent('zy_official_marketplace_auto_install', {
        installed: false,
        skipped: true,
        git_unavailable: true,
        retry_count: retryCount,
      })
      return {
        installed: false,
        skipped: true,
        reason: 'git_unavailable',
        configSaveFailed,
      }
    }

    // Attempt installation
    logForDebugging('Attempting to auto-install official marketplace')
    await addMarketplaceSource(OFFICIAL_MARKETPLACE_SOURCE)

    // Success
    logForDebugging('Successfully auto-installed official marketplace')
    const previousRetryCount = config.officialMarketplaceAutoInstallRetryCount || 0
    markAutoInstalledSuccess()
    logEvent('zy_official_marketplace_auto_install', {
      installed: true,
      skipped: false,
      retry_count: previousRetryCount,
    })
    return { installed: true, skipped: false }
  } catch (error) {
    // Handle installation failure
    const errorText = error instanceof Error ? error.message : String(error)

    // On macOS, /usr/bin/git is an xcrun shim that always exists on PATH, so
    // checkGitAvailable() (which only does `which git`) passes even without
    // Xcode CLT installed. The shim then fails at clone time with
    // "xcrun: error: invalid active developer path (...)". Poison the memoized
    // availability check so other git callers in this session skip cleanly,
    // then return silently without recording any attempt state — next startup
    // tries fresh (no backoff machinery for what is effectively "git absent").
    if (errorText.includes('xcrun: error:')) {
      markGitUnavailable()
      logForDebugging(
        'Official marketplace auto-install: git is a non-functional macOS xcrun shim, treating as git_unavailable',
      )
      logEvent('zy_official_marketplace_auto_install', {
        installed: false,
        skipped: true,
        git_unavailable: true,
        macos_xcrun_shim: true,
      })
      return {
        installed: false,
        skipped: true,
        reason: 'git_unavailable',
      }
    }

    logForDebugging(`Failed to auto-install official marketplace: ${errorText}`, {
      level: 'error',
    })
    logError(toError(error))

    const retryCount = (config.officialMarketplaceAutoInstallRetryCount || 0) + 1
    const now = Date.now()
    const nextRetryDelay = calculateNextRetryDelay(retryCount)
    const nextRetryTime = now + nextRetryDelay

    let configSaveFailed = false
    try {
      saveGlobalConfig((current) => ({
        ...current,
        officialMarketplaceAutoInstallAttempted: true,
        officialMarketplaceAutoInstalled: false,
        officialMarketplaceAutoInstallFailReason: 'unknown',
        officialMarketplaceAutoInstallRetryCount: retryCount,
        officialMarketplaceAutoInstallLastAttemptTime: now,
        officialMarketplaceAutoInstallNextRetryTime: nextRetryTime,
      }))
    } catch (saveError) {
      configSaveFailed = true
      // Log the error properly so it gets tracked
      const configError = toError(saveError)
      logError(configError)

      logForDebugging(`Failed to save marketplace auto-install failure state: ${saveError}`, {
        level: 'error',
      })

      // Still return the failure result even if config save failed
      // This ensures we report the installation failure correctly
    }
    logEvent('zy_official_marketplace_auto_install', {
      installed: false,
      skipped: true,
      failed: true,
      retry_count: retryCount,
    })

    return {
      installed: false,
      skipped: true,
      reason: 'unknown',
      configSaveFailed,
    }
  }
}
