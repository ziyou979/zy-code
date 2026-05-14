/**
 * 外部工具加载器。
 *
 * 运行时扫描 ~/.zy/tools/ 目录，动态 import 用户定义的工具，
 * 通过 adaptExternalTool() 包装后注册到 toolRegistry。
 * 加载失败不阻塞启动，仅记录警告日志。
 */
import { readdirSync, statSync, existsSync } from 'fs'
import { join, extname } from 'path'
import { getZyConfigHomeDir } from '../utils/envUtils.js'
import { logError } from '../utils/log.js'
import { logEvent } from '../services/analytics/index.js'
import { toolRegistry } from './registry.js'
import { adaptExternalTool, type ExternalToolDefinition } from './externalToolAdapter.js'

/** ~/.zy/tools/ 目录路径 */
function getExternalToolsDir(): string {
  return join(getZyConfigHomeDir(), 'tools')
}

/**
 * 验证 default export 是否满足 ExternalToolDefinition 的必需字段。
 * 不使用 Zod 验证，避免引入不必要的开销。
 */
function isValidExternalToolDefinition(value: unknown): value is ExternalToolDefinition {
  if (value == null || typeof value !== 'object') return false
  const obj = value as Record<string, unknown>
  return (
    typeof obj.name === 'string' &&
    obj.name.length > 0 &&
    typeof obj.description === 'string' &&
    obj.description.length > 0 &&
    obj.inputSchema != null &&
    typeof obj.inputSchema === 'object' &&
    typeof obj.call === 'function'
  )
}

/**
 * 收集 ~/.zy/tools/ 下所有可加载的入口文件路径。
 * 支持两种结构：
 * - 单文件工具：my-tool.ts / my-tool.js
 * - 目录工具：my-tool/index.ts / my-tool/index.js
 */
function discoverToolEntryPoints(toolsDir: string): string[] {
  const entries: string[] = []

  let items: string[]
  try {
    items = readdirSync(toolsDir)
  } catch {
    return entries
  }

  for (const item of items) {
    // 跳过隐藏文件和非工具文件
    if (item.startsWith('.') || item.startsWith('_')) continue

    const fullPath = join(toolsDir, item)
    let itemStat
    try {
      itemStat = statSync(fullPath)
    } catch {
      continue
    }

    if (itemStat.isFile()) {
      const ext = extname(item)
      if (ext === '.ts' || ext === '.js') {
        entries.push(fullPath)
      }
    } else if (itemStat.isDirectory()) {
      // 目录工具：查找 index.ts 或 index.js
      for (const indexFile of ['index.ts', 'index.js']) {
        const indexPath = join(fullPath, indexFile)
        if (existsSync(indexPath)) {
          entries.push(indexPath)
          break
        }
      }
    }
  }

  return entries
}

/**
 * 扫描 ~/.zy/tools/ 目录，动态加载用户定义的外部工具并注册到 toolRegistry。
 *
 * @returns 成功加载的工具数量
 */
export async function loadExternalTools(): Promise<number> {
  const toolsDir = getExternalToolsDir()

  if (!existsSync(toolsDir)) {
    return 0
  }

  const entryPoints = discoverToolEntryPoints(toolsDir)
  if (entryPoints.length === 0) {
    return 0
  }

  let loadedCount = 0
  const loadedNames = new Set<string>()

  for (const entryPoint of entryPoints) {
    try {
      const module = await import(entryPoint)
      const definition = module.default ?? module

      if (!isValidExternalToolDefinition(definition)) {
        logError(
          new Error(
            `External tool at "${entryPoint}" has invalid definition: must export { name: string, description: string, inputSchema: object, call: function }`,
          ),
        )
        continue
      }

      // 检查名称冲突
      if (loadedNames.has(definition.name)) {
        logError(
          new Error(
            `External tool "${definition.name}" at "${entryPoint}" conflicts with an already loaded external tool of the same name, skipping`,
          ),
        )
        continue
      }

      const tool = adaptExternalTool(definition)
      toolRegistry.register(tool)
      loadedNames.add(definition.name)
      loadedCount++
    } catch (error) {
      logError(
        new Error(
          `Failed to load external tool from "${entryPoint}": ${error instanceof Error ? error.message : String(error)}`,
        ),
      )
    }
  }

  if (loadedCount > 0) {
    logEvent('zy_external_tools_loaded', {
      count: loadedCount,
    })
  }

  return loadedCount
}
