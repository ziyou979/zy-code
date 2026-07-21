/**
 * 插件加载器模块
 *
 * 本模块负责从各种来源（包括 marketplace 和 git 仓库）发现、加载和验证 ZY Code 插件。
 *
 * 也支持 NPM 包，但必须通过 marketplace 引用 — marketplace 条目包含 NPM 包信息。
 *
 * 插件发现来源（按优先级排列）：
 * 1. 基于 Marketplace 的插件（settings 中的 plugin@marketplace 格式）
 * 2. 仅会话插件（来自 --plugin-dir CLI 标志或 SDK plugins 选项）
 *
 * 插件目录结构：
 * ```
 * my-plugin/
 * ├── plugin.json          # 可选的包含元数据的清单文件
 * ├── commands/            # 自定义斜杠命令
 * │   ├── build.md
 * │   └── deploy.md
 * ├── agents/              # 自定义 AI 代理
 * │   └── test-runner.md
 * └── hooks/               # Hook 配置
 *     └── hooks.json       # Hook 定义
 * ```
 *
 * 加载器处理：
 * - 插件清单验证
 * - Hook 配置加载和变量解析
 * - 重复名称检测
 * - 启用/禁用状态管理
 * - 错误收集和报告
 */

import { readFile, realpath, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { LoadedPlugin, PluginComponent, PluginError, PluginManifest } from '../types.js'
import { logForDebugging } from '../../../services/infra/debug.js'
import { errorMessage, toError } from '../../../utils/errors.js'
import { pathExists } from '../../../services/infra/file.js'
import { getFsImplementation } from '../../../services/infra/fsOperations.js'
import { logError } from '../../../services/infra/log.js'
import type { HooksSettings } from '../../settings/types.js'
import { jsonParse, jsonStringify } from '../../../services/infra/slowOperations.js'
import {
  type CommandMetadata,
  PluginHooksSchema,
  PluginManifestSchema,
  type PluginSource,
} from '../schemas.js'
import {
  generateTemporaryCacheNameForPlugin,
  getPluginCachePath,
  installFromGit,
  installFromGitHub,
  installFromGitSubdir,
  installFromLocal,
  installFromNpm,
} from './cachePaths.js'
import { loadPluginSettings, mergeHooksSettings, parseMonitorConfigs } from './pluginFactory.js'
/**
 * 从外部来源缓存插件
 */
export async function cachePlugin(
  source: PluginSource,
  options?: {
    manifest?: PluginManifest
  },
): Promise<{ path: string; manifest: PluginManifest; gitCommitSha?: string }> {
  const cachePath = getPluginCachePath()

  await getFsImplementation().mkdir(cachePath)

  const tempName = generateTemporaryCacheNameForPlugin(source)
  const tempPath = join(cachePath, tempName)

  let shouldCleanup = false
  let gitCommitSha: string | undefined

  try {
    logForDebugging(
      `Caching plugin from source: ${jsonStringify(source)} to temporary path ${tempPath}`,
    )

    shouldCleanup = true

    if (typeof source === 'string') {
      await installFromLocal(source, tempPath)
    } else {
      switch (source.source) {
        case 'npm':
          await installFromNpm(source.package, tempPath, {
            registry: source.registry,
            version: source.version,
          })
          break
        case 'github':
          await installFromGitHub(source.repo, tempPath, source.ref, source.sha)
          break
        case 'url':
          await installFromGit(source.url, tempPath, source.ref, source.sha)
          break
        case 'git-subdir':
          gitCommitSha = await installFromGitSubdir(
            source.url,
            tempPath,
            source.path,
            source.ref,
            source.sha,
          )
          break
        case 'pip':
          throw new Error('Python package plugins are not yet supported')
        default:
          throw new Error(`Unsupported plugin source type`)
      }
    }
  } catch (error) {
    if (shouldCleanup && (await pathExists(tempPath))) {
      logForDebugging(`Cleaning up failed installation at ${tempPath}`)
      try {
        await rm(tempPath, { recursive: true, force: true })
      } catch (cleanupError) {
        logForDebugging(`Failed to clean up installation: ${cleanupError}`, {
          level: 'error',
        })
      }
    }
    throw error
  }

  const manifestPath = join(tempPath, '.zy-plugin', 'plugin.json')
  const legacyManifestPath = join(tempPath, 'plugin.json')
  let manifest: PluginManifest

  if (await pathExists(manifestPath)) {
    try {
      const content = await readFile(manifestPath, { encoding: 'utf-8' })
      const parsed = jsonParse(content)
      const result = PluginManifestSchema().safeParse(parsed)

      if (result.success) {
        manifest = result.data
      } else {
        // 清单存在但无效 — 抛出错误
        const errors = result.error.issues
          .map((err) => `${err.path.join('.')}: ${err.message}`)
          .join(', ')

        logForDebugging(`Invalid manifest at ${manifestPath}: ${errors}`, {
          level: 'error',
        })

        throw new Error(
          `Plugin has an invalid manifest file at ${manifestPath}. Validation errors: ${errors}`,
        )
      }
    } catch (error) {
      // 检查这是否是我们刚刚抛出的验证错误
      if (error instanceof Error && error.message.includes('invalid manifest file')) {
        throw error
      }

      // JSON 解析错误
      const errorMsg = errorMessage(error)
      logForDebugging(`Failed to parse manifest at ${manifestPath}: ${errorMsg}`, {
        level: 'error',
      })

      throw new Error(
        `Plugin has a corrupt manifest file at ${manifestPath}. JSON parse error: ${errorMsg}`,
      )
    }
  } else if (await pathExists(legacyManifestPath)) {
    try {
      const content = await readFile(legacyManifestPath, {
        encoding: 'utf-8',
      })
      const parsed = jsonParse(content)
      const result = PluginManifestSchema().safeParse(parsed)

      if (result.success) {
        manifest = result.data
      } else {
        // 清单存在但无效 — 抛出错误
        const errors = result.error.issues
          .map((err) => `${err.path.join('.')}: ${err.message}`)
          .join(', ')

        logForDebugging(`Invalid legacy manifest at ${legacyManifestPath}: ${errors}`, {
          level: 'error',
        })

        throw new Error(
          `Plugin has an invalid manifest file at ${legacyManifestPath}. Validation errors: ${errors}`,
        )
      }
    } catch (error) {
      // 检查这是否是我们刚刚抛出的验证错误
      if (error instanceof Error && error.message.includes('invalid manifest file')) {
        throw error
      }

      // JSON 解析错误
      const errorMsg = errorMessage(error)
      logForDebugging(`Failed to parse legacy manifest at ${legacyManifestPath}: ${errorMsg}`, {
        level: 'error',
      })

      throw new Error(
        `Plugin has a corrupt manifest file at ${legacyManifestPath}. JSON parse error: ${errorMsg}`,
      )
    }
  } else {
    manifest = options?.manifest || {
      name: tempName,
      description: `Plugin cached from ${typeof source === 'string' ? source : source.source}`,
    }
  }

  const finalName = manifest.name.replace(/[^a-zA-Z0-9-_]/g, '-')
  const finalPath = join(cachePath, finalName)

  if (await pathExists(finalPath)) {
    logForDebugging(`Removing old cached version at ${finalPath}`)
    await rm(finalPath, { recursive: true, force: true })
  }

  await rename(tempPath, finalPath)

  logForDebugging(`Successfully cached plugin ${manifest.name} to ${finalPath}`)

  return {
    path: finalPath,
    manifest,
    ...(gitCommitSha && { gitCommitSha }),
  }
}

/**
 * 从 JSON 文件加载并验证插件清单。
 *
 * 清单提供插件的元数据，包括名称、版本、描述、作者和其他可选字段。
 * 如果清单不存在，将创建一个最小清单以使插件能够运行。
 *
 * plugin.json 示例：
 * ```json
 * {
 *   "name": "code-assistant",
 *   "version": "1.2.0",
 *   "description": "AI-powered code assistance tools",
 *   "author": {
 *     "name": "John Doe",
 *     "email": "john@example.com"
 *   },
 *   "keywords": ["coding", "ai", "assistant"],
 *   "homepage": "https://example.com/code-assistant",
 *   "hooks": "./custom-hooks.json",
 *   "commands": ["./extra-commands/*.md"]
 * }
 * ```
 */

/**
 * 从 JSON 文件加载并验证插件清单。
 *
 * 清单提供插件的元数据，包括名称、版本、描述、作者和其他可选字段。
 * 如果清单不存在，将创建一个最小清单以使插件能够运行。
 *
 * 清单中的未知键会被静默去除（PluginManifestSchema 使用 zod 的默认 strip
 * 行为，而非 .strict()）。类型不匹配和其他验证错误仍会失败。
 *
 * 行为：
 * - 文件缺失：使用提供的名称和源创建默认清单
 * - 无效 JSON：抛出包含解析详情的错误
 * - Schema 验证失败：抛出包含验证详情的错误
 *
 * @param manifestPath - plugin.json 文件的完整路径
 * @param pluginName - 默认清单中使用的名称（例如 "my-plugin"）
 * @param source - 默认清单的源描述（例如 "git:repo" 或 ".zy-plugin/name"）
 * @returns 有效的 PluginManifest 对象（加载的或默认的）
 * @throws 如果清单存在但无效（损坏的 JSON 或 schema 验证失败）则抛出错误
 */
export async function loadPluginManifest(
  manifestPath: string,
  pluginName: string,
  source: string,
): Promise<PluginManifest> {
  // 检查清单文件是否存在
  // 如果不存在，创建最小清单以使插件能够运行
  if (!(await pathExists(manifestPath))) {
    // 使用提供的名称和源返回默认清单
    return {
      name: pluginName,
      description: `Plugin from ${source}`,
    }
  }

  try {
    // 读取并解析清单 JSON 文件
    const content = await readFile(manifestPath, { encoding: 'utf-8' })
    const parsedJson = jsonParse(content)

    // 针对 PluginManifest schema 进行验证
    const result = PluginManifestSchema().safeParse(parsedJson)

    if (result.success) {
      // 清单有效 — 返回验证后的数据
      return result.data
    }

    // Schema 验证失败但 JSON 是有效的
    const errors = result.error.issues
      .map((err) => (err.path.length > 0 ? `${err.path.join('.')}: ${err.message}` : err.message))
      .join(', ')

    logForDebugging(
      `Plugin ${pluginName} has an invalid manifest file at ${manifestPath}. Validation errors: ${errors}`,
      { level: 'error' },
    )

    throw new Error(
      `Plugin ${pluginName} has an invalid manifest file at ${manifestPath}.\n\nValidation errors: ${errors}`,
    )
  } catch (error) {
    // 检查这是否是我们刚刚抛出的验证错误
    if (error instanceof Error && error.message.includes('invalid manifest file')) {
      throw error
    }

    // JSON 解析失败或文件读取错误
    const errorMsg = errorMessage(error)

    logForDebugging(
      `Plugin ${pluginName} has a corrupt manifest file at ${manifestPath}. Parse error: ${errorMsg}`,
      { level: 'error' },
    )

    throw new Error(
      `Plugin ${pluginName} has a corrupt manifest file at ${manifestPath}.\n\nJSON parse error: ${errorMsg}`,
    )
  }
}

/**
 * 从 JSON 文件加载并验证插件 hooks 配置。
 * 重要：仅在预期 hooks 文件存在时调用此函数。
 *
 * @param hooksConfigPath - hooks.json 文件的完整路径
 * @param pluginName - 用于错误消息的插件名称
 * @returns 验证后的 HooksSettings
 * @throws 如果文件不存在或无效则抛出错误
 */
export async function loadPluginHooks(
  hooksConfigPath: string,
  pluginName: string,
): Promise<HooksSettings> {
  if (!(await pathExists(hooksConfigPath))) {
    throw new Error(
      `Hooks file not found at ${hooksConfigPath} for plugin ${pluginName}. If the manifest declares hooks, the file must exist.`,
    )
  }

  const content = await readFile(hooksConfigPath, { encoding: 'utf-8' })
  const rawHooksConfig = jsonParse(content)

  // hooks.json 文件有一个包含 description 和 hooks 的包装结构
  // 使用 PluginHooksSchema 来验证并提取 hooks 属性
  const validatedPluginHooks = PluginHooksSchema().parse(rawHooksConfig)

  return validatedPluginHooks.hooks as HooksSettings
}

/**
 * 通过并行检查文件存在性来验证插件组件相对路径列表。
 *
 * 此辅助函数并行执行 pathExists 检查（开销较大的异步部分），
 * 同时通过顺序迭代结果来保持确定性的错误/日志顺序。
 *
 * 引入此函数是为了修复从同步→异步 fs 迁移带来的性能回退：顺序的
 * `for { await pathExists }` 循环每次迭代增加约 1-5ms 的事件循环开销。
 * 当有多个插件 × 多种组件类型时，这会累积到数百毫秒。
 *
 * @param relPaths - 要验证的来自清单/marketplace 条目的相对路径
 * @param pluginPath - 用于解析相对路径的插件根目录
 * @param pluginName - 用于错误消息的插件名称
 * @param source - PluginError 记录的源标识符
 * @param component - 这些路径所属的组件（用于错误记录）
 * @param componentLabel - 日志消息中人类可读的标签（例如 "Agent"、"Skill"）
 * @param contextLabel - 路径的来源，用于日志消息
 *   （例如 "specified in manifest but"、"from marketplace entry"）
 * @param errors - 用于推入路径未找到错误的数组（会被修改）
 * @returns 磁盘上存在的完整路径数组，保持原始顺序
 */
export async function validatePluginPaths(
  relPaths: string[],
  pluginPath: string,
  pluginName: string,
  source: string,
  component: PluginComponent,
  componentLabel: string,
  contextLabel: string,
  errors: PluginError[],
): Promise<string[]> {
  // 并行执行异步 pathExists 检查
  const checks = await Promise.all(
    relPaths.map(async (relPath) => {
      const fullPath = join(pluginPath, relPath)
      return { relPath, fullPath, exists: await pathExists(fullPath) }
    }),
  )
  // 按原始顺序处理结果，以保持错误/日志顺序确定性
  const validPaths: string[] = []
  for (const { relPath, fullPath, exists } of checks) {
    if (exists) {
      validPaths.push(fullPath)
    } else {
      logForDebugging(
        `${componentLabel} path ${relPath} ${contextLabel} not found at ${fullPath} for ${pluginName}`,
        { level: 'warn' },
      )
      logError(new Error(`Plugin component file not found: ${fullPath} for ${pluginName}`))
      errors.push({
        type: 'path-not-found',
        source,
        plugin: pluginName,
        path: fullPath,
        component,
      })
    }
  }
  return validPaths
}

/**
 * 从插件目录路径创建 LoadedPlugin 对象。
 *
 * 这是核心函数，通过扫描插件目录结构并加载所有组件来组装完整的插件表示。
 * 它同时处理具有完整清单的插件和仅有 commands 或 agents 目录的最小插件。
 *
 * 它查找的目录结构：
 * ```
 * plugin-directory/
 * ├── plugin.json          # 可选：插件清单
 * ├── commands/            # 可选：自定义斜杠命令
 * │   ├── build.md         # /build 命令
 * │   └── test.md          # /test 命令
 * ├── agents/              # 可选：自定义 AI 代理
 * │   ├── reviewer.md      # 代码审查代理
 * │   └── optimizer.md     # 性能优化代理
 * └── hooks/               # 可选：Hook 配置
 *     └── hooks.json       # Hook 定义
 * ```
 *
 * 组件检测：
 * - 清单：如果存在 plugin.json 则从中加载，否则创建默认清单
 * - 命令：如果 commands/ 目录存在则设置 commandsPath
 * - 代理：如果 agents/ 目录存在则设置 agentsPath
 * - Hooks：如果存在则从 hooks/hooks.json 加载
 *
 * 该函数对缺失组件具有容错性 - 插件可以拥有上述目录/文件的任意组合。
 * 缺失的组件文件会被报告为错误，但不会阻止插件加载。
 *
 * @param pluginPath - 插件目录的绝对路径
 * @param source - 源标识符（例如 "git:repo"、".zy-plugin/my-plugin"）
 * @param enabled - 初始启用状态（可能被 settings 覆盖）
 * @param fallbackName - 如果清单未指定名称时使用的名称
 * @param strict - 为 true 时，对重复的 hook 文件添加错误（默认：true）
 * @returns 包含 LoadedPlugin 和遇到的任何错误的对象
 */
export async function createPluginFromPath(
  pluginPath: string,
  source: string,
  enabled: boolean,
  fallbackName: string,
  strict = true,
): Promise<{ plugin: LoadedPlugin; errors: PluginError[] }> {
  const errors: PluginError[] = []

  // 步骤 1：加载或创建插件清单
  // 这提供了插件的元数据（名称、版本等）
  const manifestPath = join(pluginPath, '.zy-plugin', 'plugin.json')
  const manifest = await loadPluginManifest(manifestPath, fallbackName, source)

  // 步骤 2：创建基础插件对象
  // 从清单和参数中的必填字段开始
  const plugin: LoadedPlugin = {
    name: manifest.name, // 使用清单中的名称（或回退值）
    manifest, // 存储完整清单以供后续使用
    path: pluginPath, // 插件目录的绝对路径
    source, // 源标识符（例如 "git:repo" 或 ".zy-plugin/name"）
    repository: source, // 为了向后兼容插件仓库
    enabled, // 当前启用状态
  }

  // 步骤 3：并行自动检测可选目录
  const [commandsDirExists, agentsDirExists, skillsDirExists, outputStylesDirExists] =
    await Promise.all([
      !manifest.commands ? pathExists(join(pluginPath, 'commands')) : false,
      !manifest.agents ? pathExists(join(pluginPath, 'agents')) : false,
      !manifest.skills ? pathExists(join(pluginPath, 'skills')) : false,
      !manifest.outputStyles ? pathExists(join(pluginPath, 'output-styles')) : false,
    ])

  const commandsPath = join(pluginPath, 'commands')
  if (commandsDirExists) {
    plugin.commandsPath = commandsPath
  }

  // 步骤 3a：处理清单中的额外命令路径
  if (manifest.commands) {
    // 检查是否为对象映射（命令名称 → 元数据的记录）
    const firstValue = Object.values(manifest.commands)[0]
    if (
      typeof manifest.commands === 'object' &&
      !Array.isArray(manifest.commands) &&
      firstValue &&
      typeof firstValue === 'object' &&
      ('source' in firstValue || 'content' in firstValue)
    ) {
      // 对象映射格式：{ "about": { "source": "./README.md", ... } }
      const commandsMetadata: Record<string, CommandMetadata> = {}
      const validPaths: string[] = []

      // 并行执行 pathExists 检查；按顺序处理结果以保持
      // 错误/日志顺序确定性。
      const entries = Object.entries(manifest.commands)
      const checks = await Promise.all(
        entries.map(async ([commandName, metadata]) => {
          if (!metadata || typeof metadata !== 'object') {
            return { commandName, metadata, kind: 'skip' as const }
          }
          if (metadata.source) {
            const fullPath = join(pluginPath, metadata.source)
            return {
              commandName,
              metadata,
              kind: 'source' as const,
              fullPath,
              exists: await pathExists(fullPath),
            }
          }
          if (metadata.content) {
            return { commandName, metadata, kind: 'content' as const }
          }
          return { commandName, metadata, kind: 'skip' as const }
        }),
      )
      for (const check of checks) {
        if (check.kind === 'skip') {
          continue
        }
        if (check.kind === 'content') {
          // 对于内联内容命令，添加元数据但不添加路径
          commandsMetadata[check.commandName] = check.metadata
          continue
        }
        // kind === 'source'（源类型）
        if (check.exists) {
          validPaths.push(check.fullPath)
          commandsMetadata[check.commandName] = check.metadata
        } else {
          logForDebugging(
            `Command ${check.commandName} path ${check.metadata.source} specified in manifest but not found at ${check.fullPath} for ${manifest.name}`,
            { level: 'warn' },
          )
          logError(
            new Error(`Plugin component file not found: ${check.fullPath} for ${manifest.name}`),
          )
          errors.push({
            type: 'path-not-found',
            source,
            plugin: manifest.name,
            path: check.fullPath,
            component: 'commands',
          })
        }
      }

      // 如果有基于文件的命令则设置 commandsPaths
      if (validPaths.length > 0) {
        plugin.commandsPaths = validPaths
      }
      // 如果有任何命令（基于文件或内联的）则设置 commandsMetadata
      if (Object.keys(commandsMetadata).length > 0) {
        plugin.commandsMetadata = commandsMetadata
      }
    } else {
      // 路径或路径数组格式
      const commandPaths = Array.isArray(manifest.commands)
        ? manifest.commands
        : [manifest.commands]

      // 并行执行 pathExists 检查；按顺序处理结果。
      const checks = await Promise.all(
        commandPaths.map(async (cmdPath) => {
          if (typeof cmdPath !== 'string') {
            return { cmdPath, kind: 'invalid' as const }
          }
          const fullPath = join(pluginPath, cmdPath)
          return {
            cmdPath,
            kind: 'path' as const,
            fullPath,
            exists: await pathExists(fullPath),
          }
        }),
      )
      const validPaths: string[] = []
      for (const check of checks) {
        if (check.kind === 'invalid') {
          logForDebugging(`Unexpected command format in manifest for ${manifest.name}`, {
            level: 'error',
          })
          continue
        }
        if (check.exists) {
          validPaths.push(check.fullPath)
        } else {
          logForDebugging(
            `Command path ${check.cmdPath} specified in manifest but not found at ${check.fullPath} for ${manifest.name}`,
            { level: 'warn' },
          )
          logError(
            new Error(`Plugin component file not found: ${check.fullPath} for ${manifest.name}`),
          )
          errors.push({
            type: 'path-not-found',
            source,
            plugin: manifest.name,
            path: check.fullPath,
            component: 'commands',
          })
        }
      }

      if (validPaths.length > 0) {
        plugin.commandsPaths = validPaths
      }
    }
  }

  // 步骤 4：如果检测到则注册代理目录
  const agentsPath = join(pluginPath, 'agents')
  if (agentsDirExists) {
    plugin.agentsPath = agentsPath
  }

  // 步骤 4a：处理清单中的额外代理路径
  if (manifest.agents) {
    const agentPaths = Array.isArray(manifest.agents) ? manifest.agents : [manifest.agents]

    const validPaths = await validatePluginPaths(
      agentPaths,
      pluginPath,
      manifest.name,
      source,
      'agents',
      'Agent',
      'specified in manifest but',
      errors,
    )

    if (validPaths.length > 0) {
      plugin.agentsPaths = validPaths
    }
  }

  // 步骤 4b：如果检测到则注册技能目录
  const skillsPath = join(pluginPath, 'skills')
  if (skillsDirExists) {
    plugin.skillsPath = skillsPath
  }

  // 步骤 4c：处理清单中的额外技能路径
  if (manifest.skills) {
    const skillPaths = Array.isArray(manifest.skills) ? manifest.skills : [manifest.skills]

    const validPaths = await validatePluginPaths(
      skillPaths,
      pluginPath,
      manifest.name,
      source,
      'skills',
      'Skill',
      'specified in manifest but',
      errors,
    )

    if (validPaths.length > 0) {
      plugin.skillsPaths = validPaths
    }
  }

  // 步骤 4d：如果检测到则注册输出样式目录
  const outputStylesPath = join(pluginPath, 'output-styles')
  if (outputStylesDirExists) {
    plugin.outputStylesPath = outputStylesPath
  }

  // 步骤 4e：处理清单中的额外输出样式路径
  if (manifest.outputStyles) {
    const outputStylePaths = Array.isArray(manifest.outputStyles)
      ? manifest.outputStyles
      : [manifest.outputStyles]

    const validPaths = await validatePluginPaths(
      outputStylePaths,
      pluginPath,
      manifest.name,
      source,
      'output-styles',
      'Output style',
      'specified in manifest but',
      errors,
    )

    if (validPaths.length > 0) {
      plugin.outputStylesPaths = validPaths
    }
  }

  // 步骤 5：加载 hooks 配置
  let mergedHooks: HooksSettings | undefined
  const loadedHookPaths = new Set<string>() // 跟踪已加载的 hook 文件

  // 如果存在标准的 hooks/hooks.json 则从中加载
  const standardHooksPath = join(pluginPath, 'hooks', 'hooks.json')
  if (await pathExists(standardHooksPath)) {
    try {
      mergedHooks = await loadPluginHooks(standardHooksPath, manifest.name)
      // 跟踪规范化路径以防止重复加载
      try {
        loadedHookPaths.add(await realpath(standardHooksPath))
      } catch {
        // 如果 realpathSync 失败，使用原始路径
        loadedHookPaths.add(standardHooksPath)
      }
      logForDebugging(
        `Loaded hooks from standard location for plugin ${manifest.name}: ${standardHooksPath}`,
      )
    } catch (error) {
      const errorMsg = errorMessage(error)
      logForDebugging(`Failed to load hooks for ${manifest.name}: ${errorMsg}`, {
        level: 'error',
      })
      logError(toError(error))
      errors.push({
        type: 'hook-load-failed',
        source,
        plugin: manifest.name,
        hookPath: standardHooksPath,
        reason: errorMsg,
      })
    }
  }

  // 如果指定了 manifest.hooks 则加载并合并
  if (manifest.hooks) {
    const manifestHooksArray = Array.isArray(manifest.hooks) ? manifest.hooks : [manifest.hooks]

    for (const hookSpec of manifestHooksArray) {
      if (typeof hookSpec === 'string') {
        // 额外 hooks 文件的路径
        const hookFilePath = join(pluginPath, hookSpec)
        if (!(await pathExists(hookFilePath))) {
          logForDebugging(
            `Hooks file ${hookSpec} specified in manifest but not found at ${hookFilePath} for ${manifest.name}`,
            { level: 'error' },
          )
          logError(
            new Error(`Plugin component file not found: ${hookFilePath} for ${manifest.name}`),
          )
          errors.push({
            type: 'path-not-found',
            source,
            plugin: manifest.name,
            path: hookFilePath,
            component: 'hooks',
          })
          continue
        }

        // 检查此路径是否解析到已加载的 hooks 文件
        let normalizedPath: string
        try {
          normalizedPath = await realpath(hookFilePath)
        } catch {
          // 如果 realpathSync 失败，使用原始路径
          normalizedPath = hookFilePath
        }

        if (loadedHookPaths.has(normalizedPath)) {
          logForDebugging(
            `Skipping duplicate hooks file for plugin ${manifest.name}: ${hookSpec} ` +
              `(resolves to already-loaded file: ${normalizedPath})`,
          )
          if (strict) {
            const errorMsg = `Duplicate hooks file detected: ${hookSpec} resolves to already-loaded file ${normalizedPath}. The standard hooks/hooks.json is loaded automatically, so manifest.hooks should only reference additional hook files.`
            logError(new Error(errorMsg))
            errors.push({
              type: 'hook-load-failed',
              source,
              plugin: manifest.name,
              hookPath: hookFilePath,
              reason: errorMsg,
            })
          }
          continue
        }

        try {
          const additionalHooks = await loadPluginHooks(hookFilePath, manifest.name)
          try {
            mergedHooks = mergeHooksSettings(mergedHooks, additionalHooks)
            loadedHookPaths.add(normalizedPath)
            logForDebugging(
              `Loaded and merged hooks from manifest for plugin ${manifest.name}: ${hookSpec}`,
            )
          } catch (mergeError) {
            const mergeErrorMsg = errorMessage(mergeError)
            logForDebugging(
              `Failed to merge hooks from ${hookSpec} for ${manifest.name}: ${mergeErrorMsg}`,
              { level: 'error' },
            )
            logError(toError(mergeError))
            errors.push({
              type: 'hook-load-failed',
              source,
              plugin: manifest.name,
              hookPath: hookFilePath,
              reason: `Failed to merge: ${mergeErrorMsg}`,
            })
          }
        } catch (error) {
          const errorMsg = errorMessage(error)
          logForDebugging(
            `Failed to load hooks from ${hookSpec} for ${manifest.name}: ${errorMsg}`,
            { level: 'error' },
          )
          logError(toError(error))
          errors.push({
            type: 'hook-load-failed',
            source,
            plugin: manifest.name,
            hookPath: hookFilePath,
            reason: errorMsg,
          })
        }
      } else if (typeof hookSpec === 'object') {
        // 内联 hooks
        mergedHooks = mergeHooksSettings(mergedHooks, hookSpec as HooksSettings)
      }
    }
  }

  if (mergedHooks) {
    plugin.hooksConfig = mergedHooks
  }

  // 步骤 6：加载插件设置
  // 设置可以来自插件目录中的 settings.json 或 manifest.settings
  // 仅保留白名单中的键（当前：agent）
  const pluginSettings = await loadPluginSettings(pluginPath, manifest)
  if (pluginSettings) {
    plugin.settings = pluginSettings
  }

  // 步骤 7：解析 monitors 配置
  // monitors 在 session 启动或 skill 调用时自动启动后台进程
  if (manifest.monitors) {
    plugin.monitors = parseMonitorConfigs(manifest.monitors, manifest.name)
  }

  return { plugin, errors }
}
