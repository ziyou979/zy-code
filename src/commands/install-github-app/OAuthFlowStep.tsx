import React, { useEffect, useRef, useState } from 'react'
import { Spinner } from '../../components/Spinner.js'
import { Box, Text } from '../../ink.js'
import { getApiKey } from '../../utils/auth.js'
import { logError } from '../../utils/log.js'

interface OAuthFlowStepProps {
  onSuccess: (token: string) => void
  onCancel: () => void
}

/**
 * 获取当前 API key 用于 GitHub Actions 设置。
 * 多 Provider OAuth 模式下直接使用已登录的 provider 凭证，
 * 不再通过旧 OAuthService 创建新 token。
 */
export function OAuthFlowStep({ onSuccess, onCancel }: OAuthFlowStepProps): React.ReactNode {
  const [error, setError] = useState<string | null>(null)
  const handledRef = useRef(false)

  useEffect(() => {
    const apiKey = getApiKey()
    if (!apiKey) {
      setError('No API key found. Please login first with `zy auth login --provider <provider>`.')
      return
    }
    if (!handledRef.current) {
      handledRef.current = true
      onSuccess(apiKey)
    }
  }, [onSuccess])

  if (error) {
    return (
      <Box flexDirection="column" gap={1} tabIndex={0} autoFocus onKeyDown={() => onCancel()}>
        <Text color="error">Error: {error}</Text>
        <Text dimColor>Press any key to return to API key selection</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Box>
        <Spinner />
        <Text>Retrieving authentication token…</Text>
      </Box>
    </Box>
  )
}
