import { useCallback, useState } from 'react'
import { getIsNonInteractiveSession } from '../bootstrap/state.js'
import { verifyApiKey } from '../services/api/apiHelpers.js'
import { getApiKeyFromApiKeyHelper, getApiKeyWithSource, isAuthEnabled } from '../utils/auth.js'
export type VerificationStatus = 'loading' | 'valid' | 'invalid' | 'missing' | 'error'
export type ApiKeyVerificationResult = {
  status: VerificationStatus
  reverify: () => Promise<void>
  error: Error | null
}
export function useApiKeyVerification(): ApiKeyVerificationResult {
  const [status, setStatus] = useState<VerificationStatus>(() => {
    if (!isAuthEnabled()) {
      return 'valid'
    }
    // 初始渲染只判断来源，不执行用户级 auth.json 中的 helper。
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
      setStatus('missing')
      return
    }
    try {
      const isValid = await verifyApiKey(apiKey, false)
      setStatus(isValid ? 'valid' : 'invalid')
    } catch (verifyError) {
      setError(verifyError as Error)
      setStatus('error')
    }
  }, [])
  return {
    status,
    reverify: verify,
    error,
  }
}
