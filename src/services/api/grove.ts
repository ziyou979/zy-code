import axios from 'axios'
import memoize from 'lodash-es/memoize.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { getOauthAccountInfo, isConsumerSubscriber } from 'src/utils/auth.js'
import { logForDebugging } from 'src/utils/debug.js'
import { gracefulShutdown } from 'src/utils/gracefulShutdown.js'
import { isEssentialTrafficOnly } from 'src/utils/privacyLevel.js'
import { writeToStderr } from 'src/utils/process.js'
import { getOauthConfig } from '../../constants/oauth.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import {
  getAuthHeaders,
  getUserAgent,
  withOAuth401Retry,
} from '../../utils/http.js'
import { logError } from '../../utils/log.js'
import { getZyCodeUserAgent } from '../../utils/userAgent.js'
import { tSync } from '../../i18n/index.js'

// 缓存过期：24 小时
const GROVE_CACHE_EXPIRATION_MS = 24 * 60 * 60 * 1000

export type AccountSettings = {
  grove_enabled: boolean | null
  grove_notice_viewed_at: string | null
}

export type GroveConfig = {
  grove_enabled: boolean
  domain_excluded: boolean
  notice_is_grace_period: boolean
  notice_reminder_frequency: number | null
}

/**
 * 区分 API 调用失败与成功的返回类型。
 * - success: true 表示 API 调用成功（data 中可能仍包含 null 字段）
 * - success: false 表示 API 调用在重试后仍然失败
 */
export type ApiResult<T> = { success: true; data: T } | { success: false }

/**
 * 获取用户账户当前的 Grove 设置。
 * 返回 ApiResult 以区分 API 调用失败与成功。
 * 使用已有的 OAuth 401 重试机制，若仍失败则返回 failure。
 *
 * 会话级别缓存，避免每次渲染重复请求。
 * 缓存在 updateGroveSettings() 中会失效，确保切换后的读取值是最新的。
 */
export const getGroveSettings = memoize(
  async (): Promise<ApiResult<AccountSettings>> => {
    // Grove 是通知功能；在服务中断期间跳过是正确的。
    if (isEssentialTrafficOnly()) {
      return { success: false }
    }
    try {
      const response = await withOAuth401Retry(() => {
        const authHeaders = getAuthHeaders()
        if (authHeaders.error) {
          throw new Error(`Failed to get auth headers: ${authHeaders.error}`)
        }
        return axios.get<AccountSettings>(
          `${getOauthConfig().BASE_API_URL}/api/oauth/account/settings`,
          {
            headers: {
              ...authHeaders.headers,
              'User-Agent': getZyCodeUserAgent(),
            },
          },
        )
      })
      return { success: true, data: response.data }
    } catch (err) {
      logError(err)
      // 不要缓存失败结果——瞬态网络问题会导致用户在整个会话中
      // 无法访问隐私设置（死锁：对话框需要 success 才能渲染开关，
      // 开关调用 updateGroveSettings，那是唯一另一个清除缓存的地方）。
      getGroveSettings.cache.clear?.()
      return { success: false }
    }
  },
)

/**
 * 标记用户已查看 Grove 通知
 */
export async function markGroveNoticeViewed(): Promise<void> {
  try {
    await withOAuth401Retry(() => {
      const authHeaders = getAuthHeaders()
      if (authHeaders.error) {
        throw new Error(`Failed to get auth headers: ${authHeaders.error}`)
      }
      return axios.post(
        `${getOauthConfig().BASE_API_URL}/api/oauth/account/grove_notice_viewed`,
        {},
        {
          headers: {
            ...authHeaders.headers,
            'User-Agent': getZyCodeUserAgent(),
          },
        },
      )
    })
    // 此操作在服务端修改 grove_notice_viewed_at —— Grove.tsx:87 读取该字段
    // 来决定是否展示对话框。如果不使缓存失效，同一会话内重新挂载时
    // 会读到过期的 viewed_at:null，从而重复展示对话框。
    getGroveSettings.cache.clear?.()
  } catch (err) {
    logError(err)
  }
}

/**
 * 更新用户账户的 Grove 设置
 */
export async function updateGroveSettings(
  groveEnabled: boolean,
): Promise<void> {
  try {
    await withOAuth401Retry(() => {
      const authHeaders = getAuthHeaders()
      if (authHeaders.error) {
        throw new Error(`Failed to get auth headers: ${authHeaders.error}`)
      }
      return axios.patch(
        `${getOauthConfig().BASE_API_URL}/api/oauth/account/settings`,
        {
          grove_enabled: groveEnabled,
        },
        {
          headers: {
            ...authHeaders.headers,
            'User-Agent': getZyCodeUserAgent(),
          },
        },
      )
    })
    // 使缓存的设置失效，确保 privacy-settings.tsx 中切换后的
    // 确认读取能获取到最新值。
    getGroveSettings.cache.clear?.()
  } catch (err) {
    logError(err)
  }
}

/**
 * 检查用户是否符合 Grove 条件（非阻塞、缓存优先）。
 *
 * 此函数从不阻塞网络——它立即返回缓存数据，
 * 如有需要则在后台获取。冷启动（无缓存）时返回 false，
 * Grove 对话框要到下次会话才会显示。
 */
export async function isQualifiedForGrove(): Promise<boolean> {
  if (!isConsumerSubscriber()) {
    return false
  }

  const accountId = getOauthAccountInfo()?.accountUuid
  if (!accountId) {
    return false
  }

  const globalConfig = getGlobalConfig()
  const cachedEntry = globalConfig.groveConfigCache?.[accountId]
  const now = Date.now()

  // 无缓存——触发后台获取并返回 false（非阻塞）
  // 本次会话不会显示 Grove 对话框，但下次符合条件时会显示
  if (!cachedEntry) {
    logForDebugging(
      'Grove: 无缓存，正在后台获取配置（本次会话跳过对话框）',
    )
    void fetchAndStoreGroveConfig(accountId)
    return false
  }

  // 缓存存在但已过期——返回缓存值并在后台刷新
  if (now - cachedEntry.timestamp > GROVE_CACHE_EXPIRATION_MS) {
    logForDebugging(
      'Grove: 缓存已过期，返回缓存数据并在后台刷新',
    )
    void fetchAndStoreGroveConfig(accountId)
    return cachedEntry.grove_enabled
  }

  // 缓存有效——直接返回
  logForDebugging('Grove: 使用有效的缓存配置')
  return cachedEntry.grove_enabled
}

/**
 * 从 API 获取 Grove 配置并存入缓存
 */
async function fetchAndStoreGroveConfig(accountId: string): Promise<void> {
  try {
    const result = await getGroveNoticeConfig()
    if (!result.success) {
      return
    }
    const groveEnabled = result.data.grove_enabled
    const cachedEntry = getGlobalConfig().groveConfigCache?.[accountId]
    if (
      cachedEntry?.grove_enabled === groveEnabled &&
      Date.now() - cachedEntry.timestamp <= GROVE_CACHE_EXPIRATION_MS
    ) {
      return
    }
    saveGlobalConfig(current => ({
      ...current,
      groveConfigCache: {
        ...current.groveConfigCache,
        [accountId]: {
          grove_enabled: groveEnabled,
          timestamp: Date.now(),
        },
      },
    }))
  } catch (err) {
    logForDebugging(`Grove: 获取并存储配置失败: ${err}`)
  }
}

/**
 * 从 API 获取 Grove Statsig 配置。
 * 返回 ApiResult 以区分 API 调用失败与成功。
 * 使用已有的 OAuth 401 重试机制，若仍失败则返回 failure。
 */
export let getGroveNoticeConfig;
getGroveNoticeConfig = memoize(
  async (): Promise<ApiResult<GroveConfig>> => {
    // Grove 是通知功能；在服务中断期间跳过是正确的。
    if (isEssentialTrafficOnly()) {
      return { success: false }
    }
    try {
      const response = await withOAuth401Retry(() => {
        const authHeaders = getAuthHeaders()
        if (authHeaders.error) {
          throw new Error(`Failed to get auth headers: ${authHeaders.error}`)
        }
        return axios.get<GroveConfig>(
          `${getOauthConfig().BASE_API_URL}/api/claude_code_grove`,
          {
            headers: {
              ...authHeaders.headers,
              'User-Agent': getUserAgent(),
            },
            timeout: 3000, // 短超时——响应慢时跳过 Grove 对话框
          },
        )
      })

      // 将 API 响应映射为 GroveConfig 类型
      const {
        grove_enabled,
        domain_excluded,
        notice_is_grace_period,
        notice_reminder_frequency,
      } = response.data

      return {
        success: true,
        data: {
          grove_enabled,
          domain_excluded: domain_excluded ?? false,
          notice_is_grace_period: notice_is_grace_period ?? true,
          notice_reminder_frequency,
        },
      }
    } catch (err) {
      logForDebugging(`获取 Grove 通知配置失败: ${err}`)
      return { success: false }
    }
  },
)

/**
 * 判断是否应显示 Grove 对话框。
 * 如果任一 API 调用失败（重试后），返回 false——API 失败时隐藏对话框。
 */
export function calculateShouldShowGrove(
  settingsResult: ApiResult<AccountSettings>,
  configResult: ApiResult<GroveConfig>,
  showIfAlreadyViewed: boolean,
): boolean {
  // API 失败时隐藏对话框（重试后）
  if (!settingsResult.success || !configResult.success) {
    return false
  }

  const settings = settingsResult.data
  const config = configResult.data

  const hasChosen = settings.grove_enabled !== null
  if (hasChosen) {
    return false
  }
  if (showIfAlreadyViewed) {
    return true
  }
  if (!config.notice_is_grace_period) {
    return true
  }
  // 检查是否需要提醒用户接受条款并选择
  // 是否帮助改进 Zy。
  const reminderFrequency = config.notice_reminder_frequency
  if (reminderFrequency !== null && settings.grove_notice_viewed_at) {
    const daysSinceViewed = Math.floor(
      (Date.now() - new Date(settings.grove_notice_viewed_at).getTime()) /
        (1000 * 60 * 60 * 24),
    )
    return daysSinceViewed >= reminderFrequency
  } else {
    // 从未查看过则显示
    const viewedAt = settings.grove_notice_viewed_at
    return viewedAt === null || viewedAt === undefined
  }
}

export async function checkGroveForNonInteractive(): Promise<void> {
  const [settingsResult, configResult] = await Promise.all([
    getGroveSettings(),
    getGroveNoticeConfig(),
  ])

  // 检查用户是否尚未做出选择（API 失败时返回 false）
  const shouldShowGrove = calculateShouldShowGrove(
    settingsResult,
    configResult,
    false,
  )

  if (shouldShowGrove) {
    // shouldShowGrove 为 true 仅当两个 API 调用都成功
    const config = configResult.success ? configResult.data : null
    logEvent('zy_grove_print_viewed', {
      dismissable:
        config?.notice_is_grace_period as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    if (config === null || config.notice_is_grace_period) {
      // 宽限期仍然有效——显示提示消息并继续
      writeToStderr(
        `\n${tSync('grove.termsNotice', { date: 'October 8, 2025', command: 'zy' })}\n\n`,
      )
      await markGroveNoticeViewed()
    } else {
      // 宽限期已结束——显示错误消息并退出
      writeToStderr(
        `\n${tSync('grove.termsNoticeActionRequired', { date: 'October 8, 2025', command: 'zy' })}\n\n`,
      )
      await gracefulShutdown(1)
    }
  }
}
