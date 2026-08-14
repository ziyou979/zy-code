import { useCallback, useState } from 'react'
import { getIsNonInteractiveSession } from 'src/bootstrap/runtime/runtimeContext.js'
import { verifyApiKey } from '../services/api/apiHelpers.js'
import {
  getApiKeyFromApiKeyHelper,
  getApiKeyWithSource,
  isAuthEnabled,
} from '../services/auth/auth.js'
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
    // 配置了 apiKeyHelper 即表示存在 key 来源，即使尚未执行；
    // 返回 'loading' 表示稍后验证
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
    // 预热 apiKeyHelper cache（未配置时不执行操作），再读取所有来源。
    // getApiKeyWithSource() 会读取已经预热的 cache。
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
