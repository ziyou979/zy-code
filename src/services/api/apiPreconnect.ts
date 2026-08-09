import { getOauthConfig } from '../../constants/oauth.js'
import { profileCheckpoint } from '../telemetry/startupProfiler.js'

let fired = false

export function preconnectAnthropicApi(): void {
  if (fired) {
    return
  }
  fired = true

  if (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.ANTHROPIC_UNIX_SOCKET ||
    process.env.ZY_CODE_CLIENT_CERT ||
    process.env.ZY_CODE_CLIENT_KEY
  ) {
    // 跳过场景仍打点，便于区分「已尝试但因代理/mTLS 未发 HEAD」
    profileCheckpoint('client_prewarm')
    return
  }

  const baseUrl = process.env.ZY_CODE_BASE_URL || getOauthConfig().BASE_API_URL

  profileCheckpoint('client_prewarm')
  void fetch(baseUrl, {
    method: 'HEAD',
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {})
}
