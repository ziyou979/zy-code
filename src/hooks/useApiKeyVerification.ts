import { useCallback, useState } from 'react'
import { getIsNonInteractiveSession } from '../bootstrap/state.js'
import { verifyApiKey } from '../services/api/apiHelpers.js'
import { getAPIProvider, isAnthropicProvider } from '../services/model/providers.js'
import { getApiKeyFromApiKeyHelper, getApiKeyWithSource, isAuthEnabled } from '../utils/auth.js'
export type VerificationStatus = 'loading' | 'valid' | 'invalid' | 'missing' | 'error'
export type ApiKeyVerificationResult = {
  status: VerificationStatus
  reverify: () => Promise<void>
  error: Error | null
}
export function useApiKeyVerification(): ApiKeyVerificationResult {
  const [status, setStatus] = useState<VerificationStatus>(() => {
    // 仅 Anthropic SDK 平台需要走 zy API key / OAuth 验证；其他平台直接视为 valid
    if (!isAnthropicProvider(getAPIProvider())) {
      return 'valid'
    }
    if (!isAuthEnabled()) {
      return 'valid'
    }
    // Use skipRetrievingKeyFromApiKeyHelper to avoid executing apiKeyHelper
    // before trust dialog is shown (security: prevents RCE via settings.json)
    const { key, source } = getApiKeyWithSource({
      skipRetrievingKeyFromApiKeyHelper: true,
    })
    // If apiKeyHelper is configured, we have a key source even though we
    // haven't executed it yet - return 'loading' to indicate we'll verify later
    if (key || source === 'apiKeyHelper') {
      return 'loading'
    }
    return 'missing'
  })
  const [error, setError] = useState<Error | null>(null)
  const verify = useCallback(async (): Promise<void> => {
    // 仅 Anthropic SDK 平台需要走 zy API key / OAuth 验证；其他平台直接视为 valid
    if (!isAnthropicProvider(getAPIProvider())) {
      setStatus('valid')
      return
    }
    if (!isAuthEnabled()) {
      setStatus('valid')
      return
    }
    // Warm the apiKeyHelper cache (no-op if not configured), then read from
    // all sources. getApiKeyWithSource() reads the now-warm cache.
    await getApiKeyFromApiKeyHelper(getIsNonInteractiveSession())
    const { key: apiKey, source } = getApiKeyWithSource()
    if (!apiKey) {
      if (source === 'apiKeyHelper') {
        setStatus('error')
        setError(new Error('API key helper did not return a valid key'))
        return
      }
      const newStatus = 'missing'
      setStatus(newStatus)
      return
    }
    try {
      const isValid = await verifyApiKey(apiKey, false)
      const newStatus = isValid ? 'valid' : 'invalid'
      setStatus(newStatus)
      return
    } catch (error) {
      // This happens when there an error response from the API but it's not an invalid API key error
      // In this case, we still mark the API key as invalid - but we also log the error so we can
      // display it to the user to be more helpful
      setError(error as Error)
      const newStatus = 'error'
      setStatus(newStatus)
      return
    }
  }, [])
  return {
    status,
    reverify: verify,
    error,
  }
}
