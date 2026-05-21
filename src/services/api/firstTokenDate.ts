import axios from 'axios'
import { getOauthConfig } from '../../constants/oauth.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { getAuthHeaders } from '../../utils/http.js'
import { logError } from '../../utils/log.js'
import { getZyCodeUserAgent } from '../../utils/userAgent.js'

/**
 * 获取用户的首次 ZY Code 令牌日期并存储到配置。
 * 在成功登录后调用，以缓存他们开始使用 ZY Code 的时间。
 */
export async function fetchAndStoreZyCodeFirstTokenDate(): Promise<void> {
  try {
    const config = getGlobalConfig()

    if (config.ZyCodeFirstTokenDate !== undefined) {
      return
    }

    const authHeaders = getAuthHeaders()
    if (authHeaders.error) {
      logError(new Error(`获取认证头失败：${authHeaders.error}`))
      return
    }

    const oauthConfig = getOauthConfig()
    const url = `${oauthConfig.BASE_API_URL}/api/organization/claude_code_first_token_date`

    const response = await axios.get(url, {
      headers: {
        ...authHeaders.headers,
        'User-Agent': getZyCodeUserAgent(),
      },
      timeout: 10000,
    })

    const firstTokenDate = response.data?.first_token_date ?? null

    // 如果日期非空则验证
    if (firstTokenDate !== null) {
      const dateTime = new Date(firstTokenDate).getTime()
      if (Number.isNaN(dateTime)) {
        logError(new Error(`从 API 收到无效的 first_token_date：${firstTokenDate}`))
        // 不保存无效日期
        return
      }
    }

    saveGlobalConfig((current) => ({
      ...current,
      ZyCodeFirstTokenDate: firstTokenDate,
    }))
  } catch (error) {
    logError(error)
  }
}
