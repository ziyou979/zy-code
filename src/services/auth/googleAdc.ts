import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import { GoogleAuth } from 'google-auth-library'
import { tSync } from '../../i18n/index.js'
import { LLMAuthenticationError } from '../../types/llm.js'
import { resolveModelRequestContext } from '../model/modelRequestContext.js'
import { getAuthConfigForProvider } from './authConfig.js'
import { getZyConfigHomeDir } from '../infra/envUtils.js'

// 认证缓存由登录与请求共用；重新授权后统一失效，避免继续使用旧 refresh token。
const googleAdcClients = new Map<string, GoogleAuth>()

export function getGoogleAdcAuth(credentialsFile?: string): GoogleAuth {
  const key = credentialsFile ?? process.env.GOOGLE_APPLICATION_CREDENTIALS ?? ''
  let auth = googleAdcClients.get(key)
  if (!auth) {
    auth = new GoogleAuth({
      ...(credentialsFile ? { keyFilename: credentialsFile } : {}),
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      clientOptions: { transporterOptions: { timeout: 20000, retry: false } },
    })
    googleAdcClients.set(key, auth)
  }
  return auth
}

export function isGoogleAdcConnection(connectionId: string | undefined): boolean {
  if (!connectionId) {
    return false
  }
  const config = getAuthConfigForProvider(connectionId)
  return (
    config?.credentialType === 'google-adc' &&
    config.provider === 'vertex' &&
    config.apiFormat === 'google'
  )
}

export function getCurrentGoogleAdcConnection(): string | undefined {
  const context = resolveModelRequestContext()
  const id = context.authProfile ?? context.provider
  return isGoogleAdcConnection(id) ? id : undefined
}

export async function verifyGoogleAdcCredentials(connectionId: string): Promise<void> {
  const config = getAuthConfigForProvider(connectionId)
  if (!isGoogleAdcConnection(connectionId)) {
    throw new LLMAuthenticationError(tSync('vertex.connectionMissing'))
  }
  await verifyGoogleAdcSource(config?.vertex?.credentialsFile)
}

/** 引导期间尚未保存连接，也必须能独立验证选中的凭证来源。 */
export async function verifyGoogleAdcSource(credentialsFile?: string): Promise<void> {
  if (credentialsFile && !existsSync(credentialsFile)) {
    throw new LLMAuthenticationError(tSync('vertex.credentialsMissing'))
  }
  let token: string | null | undefined
  try {
    token = await getGoogleAdcAuth(credentialsFile).getAccessToken()
  } catch (error) {
    // OAuth 服务用 400 表示 refresh token 撤销，仍应归类为认证失败而非网络故障。
    const oauthError = error as { response?: { data?: { error?: string } } }
    if (['invalid_grant', 'invalid_client'].includes(oauthError.response?.data?.error ?? '')) {
      throw new LLMAuthenticationError(tSync('vertex.credentialsMissing'))
    }
    throw error
  }
  if (!token) {
    throw new LLMAuthenticationError(tSync('vertex.credentialsMissing'))
  }
}

/** 固定实际文件来源，避免导入后被别的终端环境或 CLOUDSDK_CONFIG 改变。 */
export function getDefaultGoogleAdcFile(): string | undefined {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return process.env.GOOGLE_APPLICATION_CREDENTIALS
  }
  const file = join(
    process.platform === 'win32'
      ? (process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'))
      : join(homedir(), '.config'),
    'gcloud',
    'application_default_credentials.json',
  )
  return existsSync(file) ? file : undefined
}

function googleCloudCommand(path: string): string {
  // Windows 批处理经 cmd 启动；拒绝能改变命令结构或展开变量的字符。
  if (!path.trim() || /["\r\n%&|<>^!]/.test(path)) {
    throw new Error(tSync('vertex.gcloudPathInvalid'))
  }
  return process.platform === 'win32' ? `"${path}"` : path
}

export async function verifyGoogleCloudCli(gcloudPath: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  try {
    await execa(googleCloudCommand(gcloudPath), ['--version'], {
      cancelSignal: signal,
      shell: process.platform === 'win32',
      stdin: 'ignore',
      timeout: 10000,
      windowsHide: true,
    })
  } catch {
    signal.throwIfAborted()
    throw new Error(tSync('vertex.gcloudMissing'))
  }
}

/** 授权先于项目选择；凭证保存到 ZYCode 独立目录，不改全局 gcloud 账户或配额项目。 */
export async function loginGoogleAdc(options: {
  gcloudPath?: string
  signal: AbortSignal
  onAuthUrl?: (url: string) => void
}): Promise<string> {
  options.signal.throwIfAborted()
  const command = googleCloudCommand(options.gcloudPath ?? 'gcloud')
  const root = join(getZyConfigHomeDir(), 'google-adc')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const credentialsDirectory = mkdtempSync(join(root, 'login-'))
  const credentialsFile = join(credentialsDirectory, 'application_default_credentials.json')
  try {
    const child = execa(
      command,
      [
        'auth',
        'application-default',
        'login',
        '--scopes=https://www.googleapis.com/auth/cloud-platform',
        '--disable-quota-project',
        '--quiet',
      ],
      {
        env: { CLOUDSDK_CONFIG: credentialsDirectory },
        cancelSignal: options.signal,
        shell: process.platform === 'win32',
        stdin: 'ignore',
        timeout: 300000,
        windowsHide: true,
      },
    )
    let output = ''
    const receiveOutput = (data: Buffer) => {
      output = (output + data.toString()).slice(-32768)
      const url = output.match(/https:\/\/accounts\.google\.com\/[^\s]+(?=\s)/)?.[0]
      if (url) {
        options.onAuthUrl?.(url)
      }
    }
    child.stdout?.on('data', receiveOutput)
    child.stderr?.on('data', receiveOutput)
    await child
    googleAdcClients.clear()
    options.signal.throwIfAborted()
    await verifyGoogleAdcSource(credentialsFile)
    return credentialsFile
  } catch (error) {
    options.signal.throwIfAborted()
    // 不向界面转储命令对象，避免 stdout / 环境变量随异常暴露凭证。
    const code =
      typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
    throw new Error(
      tSync(
        code === 'ENOENT' ||
          (error instanceof Error && /not recognized|不是内部或外部命令/.test(error.message))
          ? 'vertex.gcloudMissing'
          : 'vertex.loginFailed',
      ),
    )
  }
}
