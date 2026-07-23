/**
 * MCP 配置解析与总装：enterprise short-circuit、scope 选择和合并。
 *
 * 从 config.ts 中提取，负责 getZyCodeMcpConfigs 和 getAllMcpConfigs 的编排。
 *
 * 安全契约：
 *   - 项目 .mcp.json 的服务器必须已审批（approved）才能进入连接流程
 *   - denylist/allowlist 在最终合并后仍需生效（policy 过滤）
 *   - 插件 MCP 必须 await 异步加载成功
 *   - enterprise 配置保持独占
 */
import { join } from 'node:path'
import memoize from 'lodash-es/memoize.js'
import { getPlatform } from 'src/services/shell/platform.js'
import type { PluginError } from '../plugins/types.js'
import { createDebugLog } from '../../services/infra/debug.js'
import { getPluginMcpServers } from '../plugins/mcpPluginIntegration.js'
import { loadAllPluginsCacheOnly } from '../plugins/pluginLoader.js'
import { isRestrictedToPluginOnly } from '../settings/pluginOnlyPolicy.js'
import {
  filterMcpServersByPolicy as filterMcpServersByPolicyCore,
  mcpPolicyAdapter,
} from './configPolicy.js'
import { doesEnterpriseMcpConfigExist } from './configLookup.js'
import { getMcpConfigsByScope, getProjectMcpConfigsFromCwd } from './configRepository.js'
import {
  dedupPluginMcpServers as dedupPluginMcpServersCore,
  dedupZyAIMcpServers as dedupZyAIMcpServersCore,
  mergeZyAIMcpConfigs,
  selectEnterpriseMcpServers,
} from './configMerge.js'
import { assembleMcpConfigs, collectPluginMcpServers } from './configAssembly.js'
import { getProjectMcpServerStatus } from './projectServerApproval.js'
import { fetchZyAIMcpConfigsIfEligible } from './zyai.js'
import type { ScopedMcpServerConfig } from './types.js'
import { isMcpServerDisabled } from './serverEnablement.js'

const mcpLog = createDebugLog('mcp')

export function filterMcpServersByPolicy<T>(configs: Record<string, T>): {
  allowed: Record<string, T>
  blocked: string[]
} {
  return filterMcpServersByPolicyCore(configs, mcpPolicyAdapter.isMcpServerAllowedByPolicy)
}

// ===========================================================================
//  导出包装器
// ===========================================================================

export function dedupPluginMcpServers(
  pluginServers: Record<string, ScopedMcpServerConfig>,
  manualServers: Record<string, ScopedMcpServerConfig>,
  log: (message: string) => void = (message) => mcpLog(message),
): {
  servers: Record<string, ScopedMcpServerConfig>
  suppressed: Array<{ name: string; duplicateOf: string }>
} {
  return dedupPluginMcpServersCore(pluginServers, manualServers, log)
}

export function dedupZyAIMcpServers(
  zyAiServers: Record<string, ScopedMcpServerConfig>,
  manualServers: Record<string, ScopedMcpServerConfig>,
): {
  servers: Record<string, ScopedMcpServerConfig>
  suppressed: Array<{ name: string; duplicateOf: string }>
} {
  return dedupZyAIMcpServersCore(zyAiServers, manualServers, isMcpServerDisabled, (message) =>
    mcpLog(message),
  )
}

// 注意：configLookup / configMutations / serverEnablement 的消费者
// 应直接从各自模块导入，不再经过本文件转发

// ===========================================================================
//  配置总装
// ===========================================================================

/**
 * 获取 ZY Code MCP 配置（不含 zy.ai 连接器）。
 * 仅本地文件读取，无网络等待。
 */
export async function getZyCodeMcpConfigs(
  dynamicServers: Record<string, ScopedMcpServerConfig> = {},
): Promise<{
  servers: Record<string, ScopedMcpServerConfig>
  errors: PluginError[]
}> {
  const { servers: enterpriseServers } = getMcpConfigsByScope('enterprise')

  const enterpriseResult = selectEnterpriseMcpServers(
    enterpriseServers,
    doesEnterpriseMcpConfigExist(),
    mcpPolicyAdapter.isMcpServerAllowedByPolicy,
  )
  if (enterpriseResult) {
    return { servers: enterpriseResult.servers, errors: [] }
  }

  const mcpLocked = isRestrictedToPluginOnly('mcp')
  const noServers: { servers: Record<string, ScopedMcpServerConfig> } = { servers: {} }
  const { servers: userServers } = mcpLocked ? noServers : getMcpConfigsByScope('user')
  const { servers: projectServers } = mcpLocked ? noServers : getMcpConfigsByScope('project')
  const { servers: localServers } = mcpLocked ? noServers : getMcpConfigsByScope('local')

  const pluginResult = await loadAllPluginsCacheOnly()
  const mcpErrors: PluginError[] = []

  if (pluginResult.errors.length > 0) {
    for (const error of pluginResult.errors) {
      if (
        'isMcpPluginError' in error &&
        (error as { isMcpPluginError?: boolean }).isMcpPluginError
      ) {
        mcpErrors.push(error)
      } else {
        mcpLog(String(error))
      }
    }
  }

  const loadedPluginServers = await collectPluginMcpServers(
    pluginResult.enabled,
    mcpErrors,
    getPluginMcpServers,
  )
  const assembled = assembleMcpConfigs(
    {
      pluginServers: loadedPluginServers,
      dynamicServers,
      userServers,
      projectServers,
      localServers,
    },
    {
      isDisabled: isMcpServerDisabled,
      isDenied: mcpPolicyAdapter.isMcpServerDenied,
      isAllowed: mcpPolicyAdapter.isMcpServerAllowedByPolicy,
      getProjectStatus: getProjectMcpServerStatus,
      log: (message) => mcpLog(message),
    },
  )

  return { servers: assembled.servers, errors: [...mcpErrors, ...assembled.errors] }
}

/**
 * 获取所有 MCP 配置（含 zy.ai 连接器）。
 * zy.ai 连接器具有最低优先级。
 */
export async function getAllMcpConfigs(): Promise<{
  servers: Record<string, ScopedMcpServerConfig>
  errors: PluginError[]
}> {
  // 在企业模式下不加载 zy.ai（企业具有独占控制）
  if (doesEnterpriseMcpConfigExist()) {
    return getZyCodeMcpConfigs()
  }

  // 与 getZyCodeMcpConfigs 内部的 loadAllPluginsCacheOnly() 并行启动
  const zyaiPromise = fetchZyAIMcpConfigsIfEligible()
  const { servers: ZyCodeServers, errors } = await getZyCodeMcpConfigs({})
  const zyaiResult = await zyaiPromise
  const { allowed: zyaiMcpServers } = filterMcpServersByPolicy(zyaiResult)

  const { servers: dedupedZyAI } = dedupZyAIMcpServersCore(
    zyaiMcpServers,
    ZyCodeServers,
    isMcpServerDisabled,
    () => {},
  )

  const servers = mergeZyAIMcpConfigs(dedupedZyAI, ZyCodeServers)
  return { servers, errors }
}
