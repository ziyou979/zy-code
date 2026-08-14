import { logForDebugging } from '../../services/infra/debug.js'

/** AWS 短期凭证格式。 */
export type AwsCredentials = {
  AccessKeyId: string
  SecretAccessKey: string
  SessionToken: string
  Expiration?: string
}

/** `aws sts get-session-token` 或 `aws sts assume-role` 的输出。 */
export type AwsStsOutput = {
  Credentials: AwsCredentials
}

type AwsError = {
  name: string
}

export function isAwsCredentialsProviderError(err: unknown) {
  return (err as AwsError | undefined)?.name === 'CredentialsProviderError'
}

/** 校验 AWS STS assume-role 输出的类型守卫。 */
export function isValidAwsStsOutput(obj: unknown): obj is AwsStsOutput {
  if (!obj || typeof obj !== 'object') {
    return false
  }

  const output = obj as Record<string, unknown>

  // 检查 Credentials 是否存在并包含必需字段
  if (!output.Credentials || typeof output.Credentials !== 'object') {
    return false
  }

  const credentials = output.Credentials as Record<string, unknown>

  return (
    typeof credentials.AccessKeyId === 'string' &&
    typeof credentials.SecretAccessKey === 'string' &&
    typeof credentials.SessionToken === 'string' &&
    credentials.AccessKeyId.length > 0 &&
    credentials.SecretAccessKey.length > 0 &&
    credentials.SessionToken.length > 0
  )
}

/** 无法获取 STS caller identity 时抛出异常。 */
export async function checkStsCallerIdentity(): Promise<void> {
  const { STSClient, GetCallerIdentityCommand } = await import('@aws-sdk/client-sts')
  await new STSClient().send(new GetCallerIdentityCommand({}))
}

/**
 * 通过强制刷新清除 AWS credential provider 缓存，确保立即读取 ~/.aws/credentials 的变化。
 */
export async function clearAwsIniCache(): Promise<void> {
  try {
    logForDebugging('Clearing AWS credential provider cache')
    const { fromIni } = await import('@aws-sdk/credential-providers')
    const iniProvider = fromIni({ ignoreCache: true })
    await iniProvider() // 此调用会更新全局文件缓存
    logForDebugging('AWS credential provider cache refreshed')
  } catch (_error) {
    // 此处只需清除缓存，因此忽略错误
    logForDebugging(
      'Failed to clear AWS credential cache (this is expected if no credentials are configured)',
    )
  }
}
