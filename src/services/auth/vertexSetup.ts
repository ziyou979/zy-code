import { resolve } from 'node:path'
import { tSync } from '../../i18n/index.js'
import { getGoogleAdcAuth } from './googleAdc.js'
import {
  getAuthConfigForProvider,
  getConfiguredConnectionIds,
  setAuthConfigConnection,
} from './authConfig.js'
import { buildProxiedFetch } from '../http/proxy.js'
import { resolveVertexModelsUrl } from '../model/fetchProviderModels.js'

export type VertexSetupDraft = {
  connectionId: string
  originalConnectionId?: string
  project: string
  location: string
  credentialsFile?: string
  gcloudPath?: string
}
export type VertexProject = { id: string; name: string; number?: string }
export type VertexCheckStatus = 'ok' | 'blocked' | 'unknown'
export type VertexProjectChecks = Record<
  'project' | 'billing' | 'api' | 'predict' | 'quota',
  VertexCheckStatus
>

export function createVertexSetupDraft(connectionId?: string): VertexSetupDraft {
  const config = connectionId ? getAuthConfigForProvider(connectionId) : undefined
  let suggestedId = 'vertex'
  for (let index = 2; getAuthConfigForProvider(suggestedId); index++) {
    suggestedId = `vertex-${index}`
  }
  return {
    connectionId: connectionId ?? suggestedId,
    originalConnectionId: connectionId,
    project: config?.vertex?.project ?? '',
    location: config?.vertex?.location ?? 'global',
    credentialsFile: config?.vertex?.credentialsFile,
    gcloudPath: config?.vertex?.gcloudPath,
  }
}

export function normalizeVertexInputPath(value: string): string {
  return resolve(value.trim().replace(/^(["'])(.*)\1$/, '$2'))
}

export function isValidVertexProjectId(value: string): boolean {
  return /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(value)
}

export function saveVertexSetup(draft: VertexSetupDraft): string {
  const id = draft.connectionId.trim()
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id) || ['oauth', 'deviceId'].includes(id)) {
    throw new Error(tSync('vertex.setup.invalidConnectionId'))
  }
  if (id !== draft.originalConnectionId && getConfiguredConnectionIds().includes(id)) {
    throw new Error(tSync('vertex.setup.connectionExists'))
  }
  if (!isValidVertexProjectId(draft.project) || !/^[a-z0-9-]{2,64}$/.test(draft.location)) {
    throw new Error(tSync('vertex.setup.invalidProject'))
  }
  const modelsUrl =
    resolveVertexModelsUrl('https://aiplatform.googleapis.com/v1beta1', draft.location) ?? undefined
  const result = setAuthConfigConnection(id, {
    provider: 'vertex',
    apiFormat: 'google',
    credentialType: 'google-adc',
    // 项目或区域变更后不能残留指向旧项目的完整 publisher URL。
    baseUrl: 'https://aiplatform.googleapis.com/v1beta1',
    modelsUrl,
    vertex: {
      project: draft.project,
      location: draft.location,
      credentialsFile: draft.credentialsFile,
      gcloudPath: draft.gcloudPath,
    },
  })
  if (!result.success) {
    throw new Error(tSync('vertex.saveFailed'))
  }
  return id
}

export class VertexSetupApiError extends Error {
  constructor(readonly status?: number) {
    super(
      tSync(status === 401 ? 'vertex.credentialsMissing' : 'vertex.setup.cloudRequestFailed', {
        status: status ?? 'network',
      }),
    )
    this.name = 'VertexSetupApiError'
  }
}

/** 引导只读取项目元数据和权限，不启用付费服务，也不请求模型生成。 */
export class VertexSetupClient {
  constructor(
    private readonly options: {
      credentialsFile?: string
      fetch?: typeof fetch
      getHeaders?: (url: string) => Promise<Headers>
    } = {},
  ) {}

  private async request(url: string, signal: AbortSignal, body?: object): Promise<unknown> {
    signal.throwIfAborted()
    const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(20000)])
    try {
      const headers = this.options.getHeaders
        ? await this.options.getHeaders(url)
        : new Headers(await getGoogleAdcAuth(this.options.credentialsFile).getRequestHeaders(url))
      // 先检查项目权限，再用于计费；发现阶段不能被旧 ADC 的配额项目拦截。
      headers.delete('x-goog-user-project')
      headers.set('Content-Type', 'application/json')
      requestSignal.throwIfAborted()
      const response = await (this.options.fetch ?? buildProxiedFetch() ?? fetch)(url, {
        method: body ? 'POST' : 'GET',
        headers,
        redirect: 'error',
        ...(body && { body: JSON.stringify(body) }),
        signal: requestSignal,
      })
      if (!response.ok) {
        throw new VertexSetupApiError(response.status)
      }
      return await response.json()
    } catch (error) {
      signal.throwIfAborted()
      if (error instanceof VertexSetupApiError) {
        throw error
      }
      // 不把请求、认证头或原始 SDK 异常展示到界面。
      throw new VertexSetupApiError()
    }
  }

  async listProjects(signal: AbortSignal): Promise<VertexProject[]> {
    const projects = new Map<string, VertexProject>()
    const pageTokens = new Set<string>()
    let pageToken = ''
    do {
      const url = new URL('https://cloudresourcemanager.googleapis.com/v1/projects')
      url.searchParams.set('filter', 'lifecycleState:ACTIVE')
      url.searchParams.set('pageSize', '100')
      if (pageToken) {
        url.searchParams.set('pageToken', pageToken)
      }
      const result = (await this.request(url.toString(), signal)) as {
        projects?: {
          projectId?: string
          name?: string
          projectNumber?: string
          lifecycleState?: string
        }[]
        nextPageToken?: string
      }
      for (const project of result.projects ?? []) {
        if (project.projectId && project.lifecycleState !== 'DELETE_REQUESTED') {
          projects.set(project.projectId, {
            id: project.projectId,
            name: project.name ?? project.projectId,
            number: project.projectNumber,
          })
        }
      }
      pageToken = result.nextPageToken ?? ''
      if (pageToken) {
        if (pageTokens.has(pageToken) || pageTokens.size >= 20) {
          throw new VertexSetupApiError()
        }
        pageTokens.add(pageToken)
      }
    } while (pageToken)
    return [...projects.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  async inspectProject(project: string, signal: AbortSignal): Promise<VertexProjectChecks> {
    if (!isValidVertexProjectId(project)) {
      throw new Error(tSync('vertex.setup.invalidProject'))
    }
    const checks: VertexProjectChecks = {
      project: 'unknown',
      billing: 'unknown',
      api: 'unknown',
      predict: 'unknown',
      quota: 'unknown',
    }
    async function optional<T>(operation: () => Promise<unknown>): Promise<T | undefined> {
      try {
        return (await operation()) as T
      } catch (error) {
        signal.throwIfAborted()
        if (error instanceof VertexSetupApiError && error.status === 401) {
          throw error
        }
        return undefined
      }
    }
    const [metadata, billing, iam] = await Promise.all([
      optional<{ lifecycleState?: string; projectNumber?: string }>(() =>
        this.request(`https://cloudresourcemanager.googleapis.com/v1/projects/${project}`, signal),
      ),
      optional<{ billingEnabled?: boolean }>(() =>
        this.request(
          `https://cloudbilling.googleapis.com/v1/projects/${project}/billingInfo`,
          signal,
        ),
      ),
      optional<{ permissions?: string[] }>(() =>
        this.request(
          `https://cloudresourcemanager.googleapis.com/v1/projects/${project}:testIamPermissions`,
          signal,
          {
            permissions: ['aiplatform.endpoints.predict', 'serviceusage.services.use'],
          },
        ),
      ),
    ])
    if (metadata?.lifecycleState) {
      checks.project = metadata.lifecycleState === 'ACTIVE' ? 'ok' : 'blocked'
    }
    if (billing?.billingEnabled !== undefined) {
      checks.billing = billing.billingEnabled ? 'ok' : 'blocked'
    }
    if (iam) {
      checks.predict = iam.permissions?.includes('aiplatform.endpoints.predict') ? 'ok' : 'blocked'
      checks.quota = iam.permissions?.includes('serviceusage.services.use') ? 'ok' : 'blocked'
    }
    const projectNumber = metadata?.projectNumber
    if (projectNumber && /^\d+$/.test(projectNumber)) {
      const service = await optional<{ state?: string }>(() =>
        this.request(
          `https://serviceusage.googleapis.com/v1/projects/${projectNumber}/services/aiplatform.googleapis.com`,
          signal,
        ),
      )
      if (service?.state) {
        checks.api = service.state === 'ENABLED' ? 'ok' : 'blocked'
      }
    }
    return checks
  }
}
