import { chmod, open, rename, stat, unlink } from 'node:fs/promises'
import { dirname, join, parse } from 'node:path'
import { getCurrentProjectConfig, getGlobalConfig } from '../config/config.js'
import { getCwd } from '../environment/cwd.js'
import { createDebugLog } from '../../services/infra/debug.js'
import { getErrnoCode } from '../../utils/errors.js'
import { getFsImplementation } from '../../services/infra/fsOperations.js'
import { safeParseJSON } from '../../utils/json.js'
import { isSettingSourceEnabled } from '../settings/constants.js'
import { getManagedFilePath } from '../settings/managedPath.js'
import type { ValidationError } from '../settings/validation.js'
import { jsonStringify } from '../../services/infra/slowOperations.js'
import type { ConfigScope, McpJsonConfig, ScopedMcpServerConfig } from './types.js'
import { parseMcpConfig, addScopeToServers } from './configParsing.js'

const mcpLog = createDebugLog('mcp')

/**
 * 获取托管 MCP 配置文件的路径
 */
export function getEnterpriseMcpFilePath(): string {
  return join(getManagedFilePath(), 'managed-mcp.json')
}

/**
 * 原子写入 .mcp.json 文件
 */
export async function writeMcpjsonFile(config: McpJsonConfig): Promise<void> {
  const mcpJsonPath = join(getCwd(), '.mcp.json')

  let existingMode: number | undefined
  try {
    const stats = await stat(mcpJsonPath)
    existingMode = stats.mode
  } catch (error: unknown) {
    const code = getErrnoCode(error)
    if (code !== 'ENOENT') {
      throw error
    }
  }

  const tempPath = `${mcpJsonPath}.tmp.${process.pid}.${Date.now()}`
  const handle = await open(tempPath, 'w', existingMode ?? 0o644)
  try {
    await handle.writeFile(jsonStringify(config, null, 2), {
      encoding: 'utf8',
    })
    await handle.datasync()
  } finally {
    await handle.close()
  }

  try {
    if (existingMode !== undefined) {
      await chmod(tempPath, existingMode)
    }
    await rename(tempPath, mcpJsonPath)
  } catch (error) {
    try {
      await unlink(tempPath)
    } catch {
      // 尽力清理
    }
    throw error
  }
}

/**
 * 从文件路径读取并解析 MCP 配置
 */
export function parseMcpConfigFromFilePath(params: {
  filePath: string
  expandVars: boolean
  scope: ConfigScope
}): {
  config: McpJsonConfig | null
  errors: ValidationError[]
} {
  const { filePath, expandVars, scope } = params
  const fs = getFsImplementation()

  let configContent: string
  try {
    configContent = fs.readFileSync(filePath, { encoding: 'utf8' })
  } catch (error: unknown) {
    const code = getErrnoCode(error)
    if (code === 'ENOENT') {
      return {
        config: null,
        errors: [
          {
            file: filePath,
            path: '',
            message: `MCP config file not found: ${filePath}`,
            suggestion: 'Check that the file path is correct',
            mcpErrorMetadata: {
              scope,
              severity: 'fatal',
            },
          },
        ],
      }
    }
    mcpLog(`MCP config read error for ${filePath} (scope=${scope}): ${error}`, {
      level: 'error',
    })
    return {
      config: null,
      errors: [
        {
          file: filePath,
          path: '',
          message: `Failed to read file: ${error}`,
          suggestion: 'Check file permissions and ensure the file exists',
          mcpErrorMetadata: {
            scope,
            severity: 'fatal',
          },
        },
      ],
    }
  }

  const parsedJson = safeParseJSON(configContent)
  if (!parsedJson) {
    mcpLog(
      `MCP config is not valid JSON: ${filePath} (scope=${scope}, length=${configContent.length}, first100=${jsonStringify(configContent.slice(0, 100))})`,
      { level: 'error' },
    )
    return {
      config: null,
      errors: [
        {
          file: filePath,
          path: '',
          message: 'MCP config is not a valid JSON',
          suggestion: 'Fix the JSON syntax errors in the file',
          mcpErrorMetadata: {
            scope,
            severity: 'fatal',
          },
        },
      ],
    }
  }

  return parseMcpConfig({
    configObject: parsedJson,
    expandVars,
    scope,
    filePath,
  })
}

/**
 * 获取当前目录的 .mcp.json 配置（无父目录遍历）
 */
export function getProjectMcpConfigsFromCwd(): {
  servers: Record<string, ScopedMcpServerConfig>
  errors: ValidationError[]
} {
  if (!isSettingSourceEnabled('projectSettings')) {
    return { servers: {}, errors: [] }
  }

  const mcpJsonPath = join(getCwd(), '.mcp.json')
  const { config, errors } = parseMcpConfigFromFilePath({
    filePath: mcpJsonPath,
    expandVars: true,
    scope: 'project',
  })

  if (!config) {
    const nonMissingErrors = errors.filter(
      (error) => !error.message.startsWith('MCP config file not found'),
    )
    if (nonMissingErrors.length > 0) {
      mcpLog(
        `MCP config errors for ${mcpJsonPath}: ${jsonStringify(nonMissingErrors.map((error) => error.message))}`,
        { level: 'error' },
      )
      return { servers: {}, errors: nonMissingErrors }
    }
    return { servers: {}, errors: [] }
  }

  return {
    servers: config.mcpServers ? addScopeToServers(config.mcpServers, 'project') : {},
    errors: errors || [],
  }
}

/**
 * 按作用域获取 MCP 配置（递归查找 .mcp.json、读 user/local/enterprise 配置）
 */
export function getMcpConfigsByScope(scope: 'project' | 'user' | 'local' | 'enterprise'): {
  servers: Record<string, ScopedMcpServerConfig>
  errors: ValidationError[]
} {
  const sourceMap: Record<string, 'projectSettings' | 'userSettings' | 'localSettings'> = {
    project: 'projectSettings',
    user: 'userSettings',
    local: 'localSettings',
  }

  if (scope in sourceMap && !isSettingSourceEnabled(sourceMap[scope]!)) {
    return { servers: {}, errors: [] }
  }

  switch (scope) {
    case 'project': {
      const allServers: Record<string, ScopedMcpServerConfig> = {}
      const allErrors: ValidationError[] = []
      const dirs: string[] = []
      let currentDir = getCwd()

      while (currentDir !== parse(currentDir).root) {
        dirs.push(currentDir)
        currentDir = dirname(currentDir)
      }

      for (const dir of dirs.reverse()) {
        const mcpJsonPath = join(dir, '.mcp.json')
        const { config, errors } = parseMcpConfigFromFilePath({
          filePath: mcpJsonPath,
          expandVars: true,
          scope: 'project',
        })

        if (!config) {
          const nonMissingErrors = errors.filter(
            (error) => !error.message.startsWith('MCP config file not found'),
          )
          if (nonMissingErrors.length > 0) {
            mcpLog(
              `MCP config errors for ${mcpJsonPath}: ${jsonStringify(nonMissingErrors.map((error) => error.message))}`,
              { level: 'error' },
            )
            allErrors.push(...nonMissingErrors)
          }
          continue
        }

        if (config.mcpServers) {
          Object.assign(allServers, addScopeToServers(config.mcpServers, scope))
        }

        if (errors.length > 0) {
          allErrors.push(...errors)
        }
      }

      return {
        servers: allServers,
        errors: allErrors,
      }
    }
    case 'user': {
      const mcpServers = getGlobalConfig().mcpServers
      if (!mcpServers) {
        return { servers: {}, errors: [] }
      }

      const { config, errors } = parseMcpConfig({
        configObject: { mcpServers },
        expandVars: true,
        scope: 'user',
      })

      return {
        servers: addScopeToServers(config?.mcpServers, scope),
        errors,
      }
    }
    case 'local': {
      const mcpServers = getCurrentProjectConfig().mcpServers
      if (!mcpServers) {
        return { servers: {}, errors: [] }
      }

      const { config, errors } = parseMcpConfig({
        configObject: { mcpServers },
        expandVars: true,
        scope: 'local',
      })

      return {
        servers: addScopeToServers(config?.mcpServers, scope),
        errors,
      }
    }
    case 'enterprise': {
      const enterpriseMcpPath = getEnterpriseMcpFilePath()
      const { config, errors } = parseMcpConfigFromFilePath({
        filePath: enterpriseMcpPath,
        expandVars: true,
        scope: 'enterprise',
      })

      if (!config) {
        const nonMissingErrors = errors.filter(
          (error) => !error.message.startsWith('MCP config file not found'),
        )
        if (nonMissingErrors.length > 0) {
          mcpLog(
            `Enterprise MCP config errors for ${enterpriseMcpPath}: ${jsonStringify(nonMissingErrors.map((error) => error.message))}`,
            { level: 'error' },
          )
          return { servers: {}, errors: nonMissingErrors }
        }
        return { servers: {}, errors: [] }
      }

      return {
        servers: addScopeToServers(config.mcpServers, scope),
        errors,
      }
    }
  }
}
