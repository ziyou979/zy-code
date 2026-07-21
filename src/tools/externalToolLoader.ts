/**
 * 外部工具加载器。
 *
 * 运行时扫描用户级（~/.zy/tools/）和项目级（.zy/tools/）目录，
 * 动态 import 用户定义的工具，通过 adaptExternalTool() 包装后注册到 toolRegistry。
 * 加载失败不阻塞启动，仅记录警告日志。
 *
 * 外部工具覆盖机制：
 * 当外部工具与内置工具同名时（如 name: 'WebSearch'），
 * 内置工具可通过 hasExternalToolOverride() 检测并自动禁用，
 * 外部工具自动生效，实现用户自定义工具替换官方工具的能力。
 *
 * 重载机制（reloadExternalTools）：
 * 使用代际计数器（loadGeneration）区分新旧注册：
 * - 注册时捕获当前代际 genAtRegistration
 * - condition 闭包比较 toolGeneration.get(name) === genAtRegistration
 * - reload 时清空 Map + 递增代际 → 旧注册 condition 返回 false，
 *   新注册 condition 返回 true → 旧 Registration 被 getAll() 自然过滤
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { logEvent } from '../services/analytics/index.js'
import { getZyConfigHomeDir } from '../services/infra/envUtils.js'
import { logError } from '../services/infra/log.js'
import { getProjectDirsUpToHome } from '../services/markdown/markdownConfigLoader.js'
import { adaptExternalTool, type ExternalToolDefinition } from './externalToolAdapter.js'
import { toolRegistry } from './registry.js'

/** 已加载的外部工具名称集合，用于覆盖检测 */
const externalToolNames = new Set<string>()

/**
 * 代际计数器，每次加载递增。
 * 旧注册的 genAtRegistration < 当前代际 → condition 返回 false。
 */
let loadGeneration = 0

/**
 * 工具名 → 注册时代际的映射。
 * reload 时清空 → 旧 condition 返回 undefined === gen → false。
 */
const toolGeneration = new Map<string, number>()

/**
 * 检查指定名称是否已被外部工具覆盖。
 * 内置工具可调用此函数决定是否禁用自身。
 *
 * @param name - 工具名称
 * @returns true 如果存在同名的外部工具
 */
export function hasExternalToolOverride(name: string): boolean {
  return externalToolNames.has(name)
}

/** ~/.zy/tools/ 目录路径 */
function getExternalToolsDir(): string {
  return join(getZyConfigHomeDir(), 'tools')
}

/**
 * 收集所有需要扫描的工具目录。
 *
 * - 用户级：~/.zy/tools/（始终优先）
 * - 项目级：从 cwd 向上遍历 .zy/tools/（与 skill 逻辑一致）
 *
 * 项目级遍历不包含 homedir，因此与用户级目录无重叠。
 */
function collectExternalToolDirs(cwd: string): string[] {
  const dirs: string[] = []

  const userDir = getExternalToolsDir()
  if (existsSync(userDir)) {
    dirs.push(userDir)
  }

  const projectDirs = getProjectDirsUpToHome('tools', cwd)
  dirs.push(...projectDirs)

  return dirs
}

/**
 * 验证 default export 是否满足 ExternalToolDefinition 的必需字段。
 * 不使用 Zod 验证，避免引入不必要的开销。
 */
function isValidExternalToolDefinition(value: unknown): value is ExternalToolDefinition {
  if (value == null || typeof value !== 'object') {
    return false
  }
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
    if (item.startsWith('.') || item.startsWith('_')) {
      continue
    }

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
 * 从指定目录列表加载外部工具并注册到 toolRegistry。
 *
 * 每个工具的 condition 使用代际比较：
 *   () => toolGeneration.get(name) === genAtRegistration
 * 下次加载时递增代际 + 清空 Map → 旧 condition 返回 false。
 *
 * @param dirs - 工具目录列表
 * @param bustCache - 是否添加时间戳参数 bust 模块缓存（重载时使用）
 * @returns 成功加载的工具数量
 */
async function loadExternalToolsFromDirs(dirs: string[], bustCache: boolean): Promise<number> {
  // 递增代际，旧注册的 condition 将在下次 getAll() 时返回 false
  loadGeneration++
  const currentGen = loadGeneration

  let loadedCount = 0
  const loadedNames = new Set<string>()

  for (const dir of dirs) {
    const entryPoints = discoverToolEntryPoints(dir)
    for (const entryPoint of entryPoints) {
      try {
        // 重载时添加时间戳 bust Bun/Node 模块缓存，确保文件变更被拾取
        const importPath = bustCache ? `${entryPoint}?t=${Date.now()}` : entryPoint
        const module = await import(importPath)
        const definition = module.default ?? module

        if (!isValidExternalToolDefinition(definition)) {
          logError(
            new Error(
              `External tool at "${entryPoint}" has invalid definition: must export { name: string, description: string, inputSchema: object, call: function }`,
            ),
          )
          continue
        }

        // enabled: false 时跳过加载，快捷关闭工具
        if (definition.enabled === false) {
          continue
        }

        // 检查名称冲突（同一次加载中）
        if (loadedNames.has(definition.name)) {
          logError(
            new Error(
              `External tool "${definition.name}" at "${entryPoint}" conflicts with an already loaded external tool of the same name, skipping`,
            ),
          )
          continue
        }

        const tool = adaptExternalTool(definition)
        const genAtRegistration = currentGen
        // condition 闭包：仅当此工具的当前代际 == 注册时代际时返回 true
        toolRegistry.register(tool, () => toolGeneration.get(definition.name) === genAtRegistration)
        toolGeneration.set(definition.name, currentGen)
        externalToolNames.add(definition.name)
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
  }

  if (loadedCount > 0) {
    logEvent('zy_external_tools_loaded', {
      count: loadedCount,
    })
  }

  return loadedCount
}

/**
 * 启动时加载外部工具。
 * 扫描用户级和项目级 .zy/tools/ 目录，注册到 toolRegistry。
 */
export async function loadExternalTools(): Promise<number> {
  const dirs = collectExternalToolDirs(process.cwd())
  if (dirs.length === 0) {
    return 0
  }
  return loadExternalToolsFromDirs(dirs, false)
}

/**
 * 重置外部工具状态。
 *
 * - 清空 toolGeneration Map → 旧 condition 返回 undefined === gen → false
 * - 清空 externalToolNames → 内置工具的覆盖检测重置
 *
 * 供 reloadExternalTools() 和测试用例使用。
 * 注意：不清除 toolRegistry 中的旧 Registration（只增不减），
 * 但 condition 确保它们被 getAll() 过滤。
 */
export function clearExternalToolState(): void {
  toolGeneration.clear()
  externalToolNames.clear()
}

/**
 * 重载外部工具。
 *
 * 1. 保存重载前的工具名列表
 * 2. 清空状态 + 递增代际（旧 condition → false）
 * 3. 重新扫描所有目录、import、注册
 * 4. 计算新增/移除的工具并返回
 *
 * @param cwd - 项目工作目录（默认 process.cwd()）
 * @returns 新增、移除的工具名列表及总数
 */
export async function reloadExternalTools(
  cwd?: string,
): Promise<{ added: string[]; removed: string[]; total: number }> {
  const resolveCwd = cwd ?? process.cwd()
  const beforeNames = new Set(toolGeneration.keys())

  clearExternalToolState()

  const dirs = collectExternalToolDirs(resolveCwd)
  const count = dirs.length > 0 ? await loadExternalToolsFromDirs(dirs, true) : 0

  const afterNames = new Set(toolGeneration.keys())
  const added = [...afterNames].filter((n) => !beforeNames.has(n))
  const removed = [...beforeNames].filter((n) => !afterNames.has(n))

  return { added, removed, total: count }
}

/**
 * 获取当前代际计数器值。
 * reload 时递增，供外部判断是否需要重新读取工具列表。
 */
export function getLoadGeneration(): number {
  return loadGeneration
}

/**
 * 获取当前活跃的外部工具名称列表。
 * 用于 /tools 命令和调试。
 */
export function getActiveExternalToolNames(): string[] {
  return [...toolGeneration.keys()]
}
