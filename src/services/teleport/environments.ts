import axios from 'axios'
import { getOauthConfig } from 'src/constants/oauth.js'
import { getOrganizationUUID } from 'src/services/oauth/client.js'
import { getZyAIOAuthTokens } from '../../utils/auth.js'
import { toError } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import { getOAuthHeaders } from './api.js'

export type EnvironmentKind = 'anthropic_cloud' | 'byoc' | 'bridge'
export type EnvironmentState = 'active'

export type EnvironmentResource = {
  kind: EnvironmentKind
  environment_id: string
  name: string
  created_at: string
  state: EnvironmentState
}

export type EnvironmentListResponse = {
  environments: EnvironmentResource[]
  has_more: boolean
  first_id: string | null
  last_id: string | null
}

/**
 * 从 Environment API 获取可用环境列表
 * @returns Promise<EnvironmentResource[]> 可用环境的数组
 * @throws 当 API 请求失败或无可用访问令牌时抛出错误
 */
export async function fetchEnvironments(): Promise<EnvironmentResource[]> {
  const accessToken = getZyAIOAuthTokens()?.accessToken
  if (!accessToken) {
    throw new Error(
      'ZY Code web sessions require authentication with a Zy.ai account. API key authentication is not sufficient. Please run /login to authenticate, or check your authentication status with /status.',
    )
  }

  const orgUUID = await getOrganizationUUID()
  if (!orgUUID) {
    throw new Error('Unable to get organization UUID')
  }

  const url = `${getOauthConfig().BASE_API_URL}/v1/environment_providers`

  try {
    const headers = {
      ...getOAuthHeaders(accessToken),
      'x-organization-uuid': orgUUID,
    }

    const response = await axios.get<EnvironmentListResponse>(url, {
      headers,
      timeout: 15000,
    })

    if (response.status !== 200) {
      throw new Error(`Failed to fetch environments: ${response.status} ${response.statusText}`)
    }

    return response.data.environments
  } catch (error) {
    const err = toError(error)
    logError(err)
    throw new Error(`Failed to fetch environments: ${err.message}`)
  }
}

/**
 * 为没有环境的用户创建默认的 anthropic_cloud 环境。
 * 使用公开的 environment_providers 路由（与 fetchEnvironments 相同的认证方式）。
 */
export async function createDefaultCloudEnvironment(name: string): Promise<EnvironmentResource> {
  const accessToken = getZyAIOAuthTokens()?.accessToken
  if (!accessToken) {
    throw new Error('No access token available')
  }
  const orgUUID = await getOrganizationUUID()
  if (!orgUUID) {
    throw new Error('Unable to get organization UUID')
  }

  const url = `${getOauthConfig().BASE_API_URL}/v1/environment_providers/cloud/create`
  const response = await axios.post<EnvironmentResource>(
    url,
    {
      name,
      kind: 'anthropic_cloud',
      description: '',
      config: {
        environment_type: 'anthropic',
        cwd: '/home/user',
        init_script: null,
        environment: {},
        languages: [
          { name: 'python', version: '3.11' },
          { name: 'node', version: '20' },
        ],
        network_config: {
          allowed_hosts: [],
          allow_default_hosts: true,
        },
      },
    },
    {
      headers: {
        ...getOAuthHeaders(accessToken),
        'anthropic-beta': 'ccr-byoc-2025-07-29',
        'x-organization-uuid': orgUUID,
      },
      timeout: 15000,
    },
  )
  return response.data
}
