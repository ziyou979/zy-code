/**
 * AWS 凭据刷新与获取模块
 *
 * 将 auth.ts 中的 AWS 认证刷新逻辑抽取为独立模块，提供：
 * - 从 settings 读取 awsAuthRefresh / awsCredentialExport 配置
 * - 凭据刷新编排（带 memoize + TTL）
 * - 启动时安全预取
 *
 * 设计为可配置的刷新能力：用户在 settings.json 中配置命令，
 * 本模块负责执行、缓存与生命周期管理。
 */

import { exec } from 'node:child_process'
import chalk from 'chalk'
import { getIsNonInteractiveSession } from '../bootstrap/state.js'
import { logEvent } from '../services/analytics/index.js'
import { checkHasTrustDialogAccepted } from '../services/config/config.js'
import {
  checkStsCallerIdentity,
  clearAwsIniCache,
  isValidAwsStsOutput,
} from './aws.js'
import { AwsAuthStatusManager } from './awsAuthStatusManager.js'
import { logAntError, logForDebugging } from './debug.js'
import { execSyncWithDefaults_DEPRECATED } from './execFileNoThrow.js'
import { getInitialSettings, getSettingsForSource } from './settings/settings.js'
import { jsonParse } from './slowOperations.js'

// ─── 常量 ────────────────────────────────────────────────────────────────────

/** AWS 认证刷新命令的超时时间（3 分钟），足以完成浏览器 SSO 流程 */
const AWS_AUTH_REFRESH_TIMEOUT_MS = 3 * 60 * 1000

/** 凭据缓存默认 TTL（55 分钟），在 SSO token 过期前主动刷新 */
const CREDENTIAL_CACHE_TTL_MS = 55 * 60 * 1000

/** 凭据缓存最小 TTL 保底（60 秒） */
const CREDENTIAL_CACHE_MIN_TTL_MS = 60 * 1000

/** 凭据过期前预留的缓冲时间（5 分钟） */
const CREDENTIAL_EXPIRY_BUFFER_MS = 5 * 60 * 1000

// ─── 类型 ────────────────────────────────────────────────────────────────────

/** 通过 awsCredentialExport 获取到的 AWS 凭据 */
export type AwsRefreshedCredentials = {
  accessKeyId: string
  secretAccessKey: string
  sessionToken: string
  /** 凭据过期时间戳（ms），可选 */
  expiration?: number
}

// ─── Settings 读取 ────────────────────────────────────────────────────────────

/** 从 settings 中获取已配置的 awsAuthRefresh 命令 */
function getConfiguredAwsAuthRefresh(): string | undefined {
  const mergedSettings = getInitialSettings() || {}
  return mergedSettings.awsAuthRefresh
}

/** 从 settings 中获取已配置的 awsCredentialExport 命令 */
function getConfiguredAwsCredentialExport(): string | undefined {
  const mergedSettings = getInitialSettings() || {}
  return mergedSettings.awsCredentialExport
}

/** 检查 awsAuthRefresh 是否来自项目级设置（需信任检查） */
export function isAwsAuthRefreshFromProjectSettings(): boolean {
  const awsAuthRefresh = getConfiguredAwsAuthRefresh()
  if (!awsAuthRefresh) {
    return false
  }
  const projectSettings = getSettingsForSource('projectSettings')
  const localSettings = getSettingsForSource('localSettings')
  return (
    projectSettings?.awsAuthRefresh === awsAuthRefresh ||
    localSettings?.awsAuthRefresh === awsAuthRefresh
  )
}

/** 检查 awsCredentialExport 是否来自项目级设置（需信任检查） */
export function isAwsCredentialExportFromProjectSettings(): boolean {
  const awsCredentialExport = getConfiguredAwsCredentialExport()
  if (!awsCredentialExport) {
    return false
  }
  const projectSettings = getSettingsForSource('projectSettings')
  const localSettings = getSettingsForSource('localSettings')
  return (
    projectSettings?.awsCredentialExport === awsCredentialExport ||
    localSettings?.awsCredentialExport === awsCredentialExport
  )
}

// ─── 核心刷新逻辑 ─────────────────────────────────────────────────────────────

/**
 * 执行 awsAuthRefresh 命令进行交互式认证（如 aws sso login）。
 * 先尝试 STS caller identity 检查，仅在失败时才触发刷新。
 *
 * @returns true 表示刷新已执行，false 表示无需刷新或检查失败
 */
async function runAwsAuthRefresh(): Promise<boolean> {
  const awsAuthRefresh = getConfiguredAwsAuthRefresh()

  if (!awsAuthRefresh) {
    return false // 未配置，视为无需刷新
  }

  // 安全检查：项目级设置需先通过信任确认
  if (isAwsAuthRefreshFromProjectSettings()) {
    const hasTrust = checkHasTrustDialogAccepted()
    if (!hasTrust && !getIsNonInteractiveSession()) {
      const error = new Error(
        `Security: awsAuthRefresh executed before workspace trust is confirmed. If you see this message, post in ${MACRO.FEEDBACK_CHANNEL}.`,
      )
      logAntError('awsAuthRefresh invoked before trust check', error)
      logEvent('zy_awsAuthRefresh_missing_trust', {})
      return false
    }
  }

  try {
    logForDebugging('Fetching AWS caller identity for AWS auth refresh command')
    await checkStsCallerIdentity()
    logForDebugging('Fetched AWS caller identity, skipping AWS auth refresh command')
    return false
  } catch {
    // 仅在 caller-identity 调用失败时才执行刷新
    return refreshAwsAuth(awsAuthRefresh)
  }
}

/**
 * 运行 awsAuthRefresh 命令，实时流式输出到终端。
 * 通过 AwsAuthStatusManager 跟踪认证状态供 UI 展示。
 */
export function refreshAwsAuth(awsAuthRefresh: string): Promise<boolean> {
  logForDebugging('Running AWS auth refresh command')
  const authStatusManager = AwsAuthStatusManager.getInstance()
  authStatusManager.startAuthentication()

  return new Promise((resolve) => {
    const refreshProc = exec(awsAuthRefresh, {
      timeout: AWS_AUTH_REFRESH_TIMEOUT_MS,
    })
    refreshProc.stdout!.on('data', (data) => {
      const output = data.toString().trim()
      if (output) {
        authStatusManager.addOutput(output)
        logForDebugging(output, { level: 'debug' })
      }
    })

    refreshProc.stderr!.on('data', (data) => {
      const error = data.toString().trim()
      if (error) {
        authStatusManager.setError(error)
        logForDebugging(error, { level: 'error' })
      }
    })

    refreshProc.on('close', (code, signal) => {
      if (code === 0) {
        logForDebugging('AWS auth refresh completed successfully')
        authStatusManager.endAuthentication(true)
        void resolve(true)
      } else {
        const timedOut = signal === 'SIGTERM'
        const message = timedOut
          ? chalk.red(
              'AWS auth refresh timed out after 3 minutes. Run your auth command manually in a separate terminal.',
            )
          : chalk.red('Error running awsAuthRefresh (in settings or ~/.zy.json):')
        // biome-ignore lint/suspicious/noConsole: 用户配置的命令失败，需要可见
        console.error(message)
        authStatusManager.endAuthentication(false)
        void resolve(false)
      }
    })
  })
}

/**
 * 运行 awsCredentialExport 命令获取凭据并返回结构化结果。
 * 先尝试 STS caller identity 检查，仅在失败时才执行导出。
 */
async function getAwsCredsFromCredentialExport(): Promise<AwsRefreshedCredentials | null> {
  const awsCredentialExport = getConfiguredAwsCredentialExport()

  if (!awsCredentialExport) {
    return null
  }

  // 安全检查：项目级设置需先通过信任确认
  if (isAwsCredentialExportFromProjectSettings()) {
    const hasTrust = checkHasTrustDialogAccepted()
    if (!hasTrust && !getIsNonInteractiveSession()) {
      const error = new Error(
        `Security: awsCredentialExport executed before workspace trust is confirmed. If you see this message, post in ${MACRO.FEEDBACK_CHANNEL}.`,
      )
      logAntError('awsCredentialExport invoked before trust check', error)
      logEvent('zy_awsCredentialExport_missing_trust', {})
      return null
    }
  }

  try {
    logForDebugging('Fetching AWS caller identity for credential export command')
    await checkStsCallerIdentity()
    logForDebugging('Fetched AWS caller identity, skipping AWS credential export command')
    return null
  } catch {
    // 仅在 caller-identity 调用失败时才执行导出
    try {
      logForDebugging('Running AWS credential export command')
      const { execa } = await import('execa')
      const result = await execa(awsCredentialExport, {
        shell: true,
        reject: false,
      })
      if (result.exitCode !== 0 || !result.stdout) {
        throw new Error('awsCredentialExport did not return a valid value')
      }

      const awsOutput = jsonParse(result.stdout.trim())

      if (!isValidAwsStsOutput(awsOutput)) {
        throw new Error('awsCredentialExport did not return valid AWS STS output structure')
      }

      logForDebugging('AWS credentials retrieved from awsCredentialExport')

      const expirationStr = awsOutput.Credentials.Expiration
      const expirationMs =
        typeof expirationStr === 'string' ? Date.parse(expirationStr) : NaN

      return {
        accessKeyId: awsOutput.Credentials.AccessKeyId,
        secretAccessKey: awsOutput.Credentials.SecretAccessKey,
        sessionToken: awsOutput.Credentials.SessionToken,
        expiration: Number.isFinite(expirationMs) ? expirationMs : undefined,
      }
    } catch (e) {
      const message = chalk.red(
        'Error getting AWS credentials from awsCredentialExport (in settings or ~/.zy.json):',
      )
      if (e instanceof Error) {
        // biome-ignore lint/suspicious/noConsole: 用户配置的命令失败，需要可见
        console.error(message, e.message)
      } else {
        // biome-ignore lint/suspicious/noConsole
        console.error(message, e)
      }
      return null
    }
  }
}

// ─── 编排层（带 memoize） ─────────────────────────────────────────────────────

type CachedCredentials = AwsRefreshedCredentials | null

let _credentialCache: { value: CachedCredentials; timestamp: number } | null = null
let _credentialInFlight: Promise<CachedCredentials> | null = null
/** 冷却计数器：每次 reset 时递增，使旧的 in-flight 请求失效 */
let _cooldownEpoch = 0

/**
 * 计算凭据缓存 TTL：基于过期时间动态计算，保底 60 秒，上限 55 分钟
 */
function computeCredentialTTL(creds: CachedCredentials): number {
  const exp = creds?.expiration
  if (exp === undefined || exp <= Date.now()) {
    return CREDENTIAL_CACHE_TTL_MS
  }
  return Math.max(exp - Date.now() - CREDENTIAL_EXPIRY_BUFFER_MS, CREDENTIAL_CACHE_MIN_TTL_MS)
}

/**
 * 获取 AWS 凭据（带 memoize + 动态 TTL）。
 *
 * 编排流程：
 * 1. 尝试 awsAuthRefresh（刷新 SSO session）
 * 2. 尝试 awsCredentialExport（导出临时凭据）
 * 3. 刷新成功后清除 SDK 凭据缓存以读取最新配置
 *
 * 并发调用会自动去重（in-flight dedup），避免重复执行认证命令。
 */
export async function refreshAndGetAwsCredentials(): Promise<CachedCredentials> {
  const now = Date.now()

  // 缓存命中且未过期
  if (_credentialCache) {
    const ttl = computeCredentialTTL(_credentialCache.value)
    if (now - _credentialCache.timestamp < ttl) {
      return _credentialCache.value
    }
    // 过期但在刷新中 —— 返回旧值（SWR 模式）
    if (!_credentialInFlight) {
      const epoch = _cooldownEpoch
      _credentialInFlight = _doRefresh(epoch).finally(() => {
        if (_cooldownEpoch === epoch) {
          _credentialInFlight = null
        }
      })
    }
    return _credentialCache.value
  }

  // 冷启动去重
  if (_credentialInFlight) {
    return _credentialInFlight
  }

  const epoch = _cooldownEpoch
  _credentialInFlight = _doRefresh(epoch).finally(() => {
    if (_cooldownEpoch === epoch) {
      _credentialInFlight = null
    }
  })
  return _credentialInFlight
}

async function _doRefresh(epoch: number): Promise<CachedCredentials> {
  const startTime = performance.now()
  logForDebugging('[API:auth] AWS credential resolve start')

  const refreshResult = await runAwsAuthRefresh()
  const credResult = await getAwsCredsFromCredentialExport()

  // 任一操作成功后，清除 SDK 凭据缓存以读取最新 ~/.aws/credentials
  if (refreshResult || credResult) {
    await clearAwsIniCache()
  }

  logForDebugging(
    `[API:auth] AWS credential resolve done in ${Math.round(performance.now() - startTime)}ms`,
  )

  // epoch 不一致说明中途被 reset，丢弃本次结果
  if (epoch !== _cooldownEpoch) {
    return credResult
  }

  if (credResult !== null) {
    _credentialCache = { value: credResult, timestamp: Date.now() }
  }
  return credResult
}

/** 清除凭据缓存，下次调用 refreshAndGetAwsCredentials 时会重新获取 */
export function clearAwsCredentialsCache(): void {
  _credentialCache = null
  _credentialInFlight = null
}

/** 重置刷新冷却状态（settings 变更后调用，使下次请求立即刷新） */
export function resetAwsAuthRefreshCooldown(): void {
  _cooldownEpoch++
  _credentialCache = null
  _credentialInFlight = null
}

// ─── 预取入口 ─────────────────────────────────────────────────────────────────

/**
 * 启动时安全预取 AWS 凭据。
 *
 * 仅在以下条件触发：
 * - settings 中配置了 awsAuthRefresh 或 awsCredentialExport
 * - 若来自项目设置，需已通过信任确认
 *
 * 不阻塞启动（fire-and-forget），失败不影响后续使用。
 */
export function prefetchAwsCredentialsIfSafe(): void {
  const hasRefresh = !!getConfiguredAwsAuthRefresh()
  const hasExport = !!getConfiguredAwsCredentialExport()

  if (!hasRefresh && !hasExport) {
    return
  }

  // 项目级设置需要信任确认
  if (isAwsAuthRefreshFromProjectSettings() || isAwsCredentialExportFromProjectSettings()) {
    if (!checkHasTrustDialogAccepted() && !getIsNonInteractiveSession()) {
      return
    }
  }

  // fire-and-forget，不阻塞启动
  void refreshAndGetAwsCredentials()
}
