import { readFile } from 'node:fs/promises'
import memoize from 'lodash-es/memoize.js'
import type { ToolPermissionContext } from '../tools/tool.js'
import { isInternalBuild } from '../services/infra/envUtils.js'
import { jsonStringify } from '../services/infra/slowOperations.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from './analytics/index.js'

/**
 * 获取当前 Kubernetes 命名空间：
 * 笔记本/本地开发环境返回 null，
 * default 命名空间的 devbox 返回 "default"，
 * ts 命名空间的 devbox 返回 "ts"，
 * ...
 */
const getKubernetesNamespace = memoize(async (): Promise<string | null> => {
  if (!isInternalBuild()) {
    return null
  }
  const namespacePath = '/var/run/secrets/kubernetes.io/serviceaccount/namespace'
  const namespaceNotFound = 'namespace not found'
  try {
    const content = await readFile(namespacePath, { encoding: 'utf8' })
    return content.trim()
  } catch {
    return namespaceNotFound
  }
})

/**
 * 从运行中的容器内获取 OCI 容器 ID
 */
export const getContainerId = memoize(async (): Promise<string | null> => {
  if (!isInternalBuild()) {
    return null
  }
  const containerIdPath = '/proc/self/mountinfo'
  const containerIdNotFound = 'container ID not found'
  const containerIdNotFoundInMountinfo = 'container ID not found in mountinfo'
  try {
    const mountinfo = (await readFile(containerIdPath, { encoding: 'utf8' })).trim()

    // Pattern to match both Docker and containerd/CRI-O container IDs
    // Docker: /docker/containers/[64-char-hex]
    // Containerd: /sandboxes/[64-char-hex]
    const containerIdPattern = /(?:\/docker\/containers\/|\/sandboxes\/)([0-9a-f]{64})/

    const lines = mountinfo.split('\n')

    for (const line of lines) {
      const match = line.match(containerIdPattern)
      if (match?.[1]) {
        return match[1]
      }
    }

    return containerIdNotFoundInMountinfo
  } catch {
    return containerIdNotFound
  }
})

/**
 * 记录带有当前命名空间和工具权限上下文的事件
 */
export async function logPermissionContextForAnts(
  toolPermissionContext: ToolPermissionContext | null,
  moment: 'summary' | 'initialization',
): Promise<void> {
  if (!isInternalBuild()) {
    return
  }

  void logEvent('zy_internal_record_permission_context', {
    moment: moment as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    namespace:
      (await getKubernetesNamespace()) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    toolPermissionContext: jsonStringify(
      toolPermissionContext,
    ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    containerId:
      (await getContainerId()) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
}
