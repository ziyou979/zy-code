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

import { basename, join, resolve } from 'node:path'
import memoize from 'lodash-es/memoize.js'
import { getInlinePlugins } from '../../../bootstrap/runtime/runtimeContext.js'
import { getBuiltinPlugins } from '../builtinRegistry.js'
import type { LoadedPlugin, PluginError, PluginLoadResult, PluginManifest } from '../types.js'
import { logForDebugging } from '../../../services/infra/debug.js'
import { isEnvTruthy } from '../../../services/infra/envUtils.js'
import { errorMessage } from '../../../utils/errors.js'
import { pathExists } from '../../../services/infra/file.js'
import { logError } from '../../../services/infra/log.js'
import {
  clearPluginSettingsBase,
  getPluginSettingsBase,
  resetSettingsCache,
  setPluginSettingsBase,
} from '../../settings/settingsCache.js'
import type { HooksSettings } from '../../settings/types.js'
import { verifyAndDemote } from '../dependencyResolver.js'
import { getManagedPluginNames } from '../managedPlugins.js'
import { type CommandMetadata, type PluginMarketplaceEntry } from '../schemas.js'
import { createPluginFromPath, validatePluginPaths } from './sourceInstallers.js'
import { loadPluginsFromMarketplaces } from './pluginFactory.js'
/**
 * 两个 loadPluginFromMarketplaceEntry 变体的共享尾部。
 *
 * 一旦 pluginPath 解析完成（通过克隆、缓存或 installPath 查找），
 * 加载的其余部分 — 清单探测、createPluginFromPath、marketplace
 * 条目补充 — 是相同的。提取出来以便仅缓存路径
 * 不需要重复约 500 行代码。
 */
export async function finishLoadingPluginFromPath(
  entry: PluginMarketplaceEntry,
  pluginId: string,
  enabled: boolean,
  errorsOut: PluginError[],
  pluginPath: string,
): Promise<LoadedPlugin | null> {
  const errors: PluginError[] = []

  // 检查 plugin.json 是否存在以确定是否应使用 marketplace 清单
  const manifestPath = join(pluginPath, '.zy-plugin', 'plugin.json')
  const hasManifest = await pathExists(manifestPath)

  const { plugin, errors: pluginErrors } = await createPluginFromPath(
    pluginPath,
    pluginId,
    enabled,
    entry.name,
    entry.strict ?? true, // 尊重 marketplace 条目的 strict 设置
  )
  errors.push(...pluginErrors)

  // 如果可用则从源设置 sha（用于 github 和 url 源类型）
  if (typeof entry.source === 'object' && 'sha' in entry.source && entry.source.sha) {
    plugin.sha = entry.source.sha
  }

  // 如果没有 plugin.json，使用 marketplace 条目作为清单（无论 strict 模式）
  if (!hasManifest) {
    plugin.manifest = {
      ...entry,
      id: undefined,
      source: undefined,
      strict: undefined,
    } as PluginManifest
    plugin.name = plugin.manifest.name

    // 处理来自 marketplace 条目的命令
    if (entry.commands) {
      // 检查是否为对象映射
      const firstValue = Object.values(entry.commands)[0]
      if (
        typeof entry.commands === 'object' &&
        !Array.isArray(entry.commands) &&
        firstValue &&
        typeof firstValue === 'object' &&
        ('source' in firstValue || 'content' in firstValue)
      ) {
        // 对象映射格式
        const commandsMetadata: Record<string, CommandMetadata> = {}
        const validPaths: string[] = []

        // 并行执行 pathExists 检查；按顺序处理结果。
        const entries = Object.entries(entry.commands)
        const checks = await Promise.all(
          entries.map(async ([commandName, metadata]) => {
            if (!metadata || typeof metadata !== 'object' || !metadata.source) {
              return { commandName, metadata, skip: true as const }
            }
            const fullPath = join(pluginPath, metadata.source)
            return {
              commandName,
              metadata,
              skip: false as const,
              fullPath,
              exists: await pathExists(fullPath),
            }
          }),
        )
        for (const check of checks) {
          if (check.skip) {
            continue
          }
          if (check.exists) {
            validPaths.push(check.fullPath)
            commandsMetadata[check.commandName] = check.metadata
          } else {
            logForDebugging(
              `Command ${check.commandName} path ${check.metadata.source} from marketplace entry not found at ${check.fullPath} for ${entry.name}`,
              { level: 'warn' },
            )
            logError(
              new Error(`Plugin component file not found: ${check.fullPath} for ${entry.name}`),
            )
            errors.push({
              type: 'path-not-found',
              source: pluginId,
              plugin: entry.name,
              path: check.fullPath,
              component: 'commands',
            })
          }
        }

        if (validPaths.length > 0) {
          plugin.commandsPaths = validPaths
          plugin.commandsMetadata = commandsMetadata
        }
      } else {
        // 路径或路径数组格式
        const commandPaths = Array.isArray(entry.commands) ? entry.commands : [entry.commands]

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
            logForDebugging(`Unexpected command format in marketplace entry for ${entry.name}`, {
              level: 'error',
            })
            continue
          }
          if (check.exists) {
            validPaths.push(check.fullPath)
          } else {
            logForDebugging(
              `Command path ${check.cmdPath} from marketplace entry not found at ${check.fullPath} for ${entry.name}`,
              { level: 'warn' },
            )
            logError(
              new Error(`Plugin component file not found: ${check.fullPath} for ${entry.name}`),
            )
            errors.push({
              type: 'path-not-found',
              source: pluginId,
              plugin: entry.name,
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

    // 处理来自 marketplace 条目的代理
    if (entry.agents) {
      const agentPaths = Array.isArray(entry.agents) ? entry.agents : [entry.agents]

      const validPaths = await validatePluginPaths(
        agentPaths,
        pluginPath,
        entry.name,
        pluginId,
        'agents',
        'Agent',
        'from marketplace entry',
        errors,
      )

      if (validPaths.length > 0) {
        plugin.agentsPaths = validPaths
      }
    }

    // 处理来自 marketplace 条目的技能
    if (entry.skills) {
      logForDebugging(
        `Processing ${Array.isArray(entry.skills) ? entry.skills.length : 1} skill paths for plugin ${entry.name}`,
      )
      const skillPaths = Array.isArray(entry.skills) ? entry.skills : [entry.skills]

      // 并行执行 pathExists 检查，并按顺序处理结果。注意：此前此循环每轮会调用
      // 两次 pathExists()（一次在 debug 日志模板中，一次在 if 中），现在只调用一次。
      const checks = await Promise.all(
        skillPaths.map(async (skillPath) => {
          const fullPath = join(pluginPath, skillPath)
          return { skillPath, fullPath, exists: await pathExists(fullPath) }
        }),
      )
      const validPaths: string[] = []
      for (const { skillPath, fullPath, exists } of checks) {
        logForDebugging(`Checking skill path: ${skillPath} -> ${fullPath} (exists: ${exists})`)
        if (exists) {
          validPaths.push(fullPath)
        } else {
          logForDebugging(
            `Skill path ${skillPath} from marketplace entry not found at ${fullPath} for ${entry.name}`,
            { level: 'warn' },
          )
          logError(new Error(`Plugin component file not found: ${fullPath} for ${entry.name}`))
          errors.push({
            type: 'path-not-found',
            source: pluginId,
            plugin: entry.name,
            path: fullPath,
            component: 'skills',
          })
        }
      }

      logForDebugging(
        `Found ${validPaths.length} valid skill paths for plugin ${entry.name}, setting skillsPaths`,
      )
      if (validPaths.length > 0) {
        plugin.skillsPaths = validPaths
      }
    } else {
      logForDebugging(`Plugin ${entry.name} has no entry.skills defined`)
    }

    // 处理来自 marketplace 条目的输出样式
    if (entry.outputStyles) {
      const outputStylePaths = Array.isArray(entry.outputStyles)
        ? entry.outputStyles
        : [entry.outputStyles]

      const validPaths = await validatePluginPaths(
        outputStylePaths,
        pluginPath,
        entry.name,
        pluginId,
        'output-styles',
        'Output style',
        'from marketplace entry',
        errors,
      )

      if (validPaths.length > 0) {
        plugin.outputStylesPaths = validPaths
      }
    }

    // 处理来自 marketplace 条目的内联 hooks
    if (entry.hooks) {
      plugin.hooksConfig = entry.hooks as HooksSettings
    }
  } else if (
    !entry.strict &&
    hasManifest &&
    (entry.commands || entry.agents || entry.skills || entry.hooks || entry.outputStyles)
  ) {
    // 在非 strict 模式下有 plugin.json 时，marketplace 条目中的 commands/agents/skills/hooks/outputStyles 是冲突的
    const error = new Error(
      `Plugin ${entry.name} has both plugin.json and marketplace manifest entries for commands/agents/skills/hooks/outputStyles. This is a conflict.`,
    )
    logForDebugging(
      `Plugin ${entry.name} has both plugin.json and marketplace manifest entries for commands/agents/skills/hooks/outputStyles. This is a conflict.`,
      { level: 'error' },
    )
    logError(error)
    errorsOut.push({
      type: 'generic-error',
      source: pluginId,
      error: `Plugin ${entry.name} has conflicting manifests: both plugin.json and marketplace entry specify components. Set strict: true in marketplace entry or remove component specs from one location.`,
    })
    return null
  } else if (hasManifest) {
    // 有 plugin.json - marketplace 可以补充 commands/agents/skills/hooks/outputStyles

    // 从 marketplace 条目补充命令
    if (entry.commands) {
      // 检查是否为对象映射
      const firstValue = Object.values(entry.commands)[0]
      if (
        typeof entry.commands === 'object' &&
        !Array.isArray(entry.commands) &&
        firstValue &&
        typeof firstValue === 'object' &&
        ('source' in firstValue || 'content' in firstValue)
      ) {
        // 对象映射格式 - 合并元数据
        const commandsMetadata: Record<string, CommandMetadata> = {
          ...(plugin.commandsMetadata || {}),
        }
        const validPaths: string[] = []

        // 并行执行 pathExists 检查，并按顺序处理结果。
        const entries = Object.entries(entry.commands)
        const checks = await Promise.all(
          entries.map(async ([commandName, metadata]) => {
            if (!metadata || typeof metadata !== 'object' || !metadata.source) {
              return { commandName, metadata, skip: true as const }
            }
            const fullPath = join(pluginPath, metadata.source)
            return {
              commandName,
              metadata,
              skip: false as const,
              fullPath,
              exists: await pathExists(fullPath),
            }
          }),
        )
        for (const check of checks) {
          if (check.skip) {
            continue
          }
          if (check.exists) {
            validPaths.push(check.fullPath)
            commandsMetadata[check.commandName] = check.metadata
          } else {
            logForDebugging(
              `Command ${check.commandName} path ${check.metadata.source} from marketplace entry not found at ${check.fullPath} for ${entry.name}`,
              { level: 'warn' },
            )
            logError(
              new Error(`Plugin component file not found: ${check.fullPath} for ${entry.name}`),
            )
            errors.push({
              type: 'path-not-found',
              source: pluginId,
              plugin: entry.name,
              path: check.fullPath,
              component: 'commands',
            })
          }
        }

        if (validPaths.length > 0) {
          plugin.commandsPaths = [...(plugin.commandsPaths || []), ...validPaths]
          plugin.commandsMetadata = commandsMetadata
        }
      } else {
        // 路径或路径数组格式
        const commandPaths = Array.isArray(entry.commands) ? entry.commands : [entry.commands]

        // 并行执行 pathExists 检查，并按顺序处理结果。
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
            logForDebugging(`Unexpected command format in marketplace entry for ${entry.name}`, {
              level: 'error',
            })
            continue
          }
          if (check.exists) {
            validPaths.push(check.fullPath)
          } else {
            logForDebugging(
              `Command path ${check.cmdPath} from marketplace entry not found at ${check.fullPath} for ${entry.name}`,
              { level: 'warn' },
            )
            logError(
              new Error(`Plugin component file not found: ${check.fullPath} for ${entry.name}`),
            )
            errors.push({
              type: 'path-not-found',
              source: pluginId,
              plugin: entry.name,
              path: check.fullPath,
              component: 'commands',
            })
          }
        }

        if (validPaths.length > 0) {
          plugin.commandsPaths = [...(plugin.commandsPaths || []), ...validPaths]
        }
      }
    }

    // 从 marketplace 条目补充代理
    if (entry.agents) {
      const agentPaths = Array.isArray(entry.agents) ? entry.agents : [entry.agents]

      const validPaths = await validatePluginPaths(
        agentPaths,
        pluginPath,
        entry.name,
        pluginId,
        'agents',
        'Agent',
        'from marketplace entry',
        errors,
      )

      if (validPaths.length > 0) {
        plugin.agentsPaths = [...(plugin.agentsPaths || []), ...validPaths]
      }
    }

    // 从 marketplace 条目补充技能
    if (entry.skills) {
      const skillPaths = Array.isArray(entry.skills) ? entry.skills : [entry.skills]

      const validPaths = await validatePluginPaths(
        skillPaths,
        pluginPath,
        entry.name,
        pluginId,
        'skills',
        'Skill',
        'from marketplace entry',
        errors,
      )

      if (validPaths.length > 0) {
        plugin.skillsPaths = [...(plugin.skillsPaths || []), ...validPaths]
      }
    }

    // 从 marketplace 条目补充输出样式
    if (entry.outputStyles) {
      const outputStylePaths = Array.isArray(entry.outputStyles)
        ? entry.outputStyles
        : [entry.outputStyles]

      const validPaths = await validatePluginPaths(
        outputStylePaths,
        pluginPath,
        entry.name,
        pluginId,
        'output-styles',
        'Output style',
        'from marketplace entry',
        errors,
      )

      if (validPaths.length > 0) {
        plugin.outputStylesPaths = [...(plugin.outputStylesPaths || []), ...validPaths]
      }
    }

    // 从 marketplace 条目补充 hooks
    if (entry.hooks) {
      plugin.hooksConfig = {
        ...(plugin.hooksConfig || {}),
        ...(entry.hooks as HooksSettings),
      }
    }
  }

  errorsOut.push(...errors)
  return plugin
}

/**
 * 从 --plugin-dir CLI 标志加载仅会话插件。
 *
 * 这些插件直接加载，不通过 marketplace 系统。
 * 它们以 source='plugin-name@inline' 出现，并且在当前会话中始终启用。
 *
 * @param sessionPluginPaths - 来自 CLI 的插件目录路径数组
 * @returns LoadedPlugin 对象和遇到的任何错误
 */
export async function loadSessionOnlyPlugins(
  sessionPluginPaths: Array<string>,
): Promise<{ plugins: LoadedPlugin[]; errors: PluginError[] }> {
  if (sessionPluginPaths.length === 0) {
    return { plugins: [], errors: [] }
  }

  const plugins: LoadedPlugin[] = []
  const errors: PluginError[] = []

  for (const [index, pluginPath] of sessionPluginPaths.entries()) {
    try {
      const resolvedPath = resolve(pluginPath)

      if (!(await pathExists(resolvedPath))) {
        logForDebugging(`Plugin path does not exist: ${resolvedPath}, skipping`, { level: 'warn' })
        errors.push({
          type: 'path-not-found',
          source: `inline[${index}]`,
          path: resolvedPath,
          component: 'commands',
        })
        continue
      }

      const dirName = basename(resolvedPath)
      const { plugin, errors: pluginErrors } = await createPluginFromPath(
        resolvedPath,
        `${dirName}@inline`, // 临时的，在知道真实名称后会更新
        true, // always enabled
        dirName,
      )

      // 更新源以使用清单中的实际插件名称
      plugin.source = `${plugin.name}@inline`
      plugin.repository = `${plugin.name}@inline`

      plugins.push(plugin)
      errors.push(...pluginErrors)

      logForDebugging(`Loaded inline plugin from path: ${plugin.name}`)
    } catch (error) {
      const errorMsg = errorMessage(error)
      logForDebugging(`Failed to load session plugin from ${pluginPath}: ${errorMsg}`, {
        level: 'warn',
      })
      errors.push({
        type: 'generic-error',
        source: `inline[${index}]`,
        error: `Failed to load plugin: ${errorMsg}`,
      })
    }
  }

  if (plugins.length > 0) {
    logForDebugging(`Loaded ${plugins.length} session-only plugins from --plugin-dir`)
  }

  return { plugins, errors }
}

/**
 * 合并来自会话（--plugin-dir）、marketplace（已安装）和内置源的插件。
 * 会话插件覆盖同名的 marketplace 插件 — 用户在本次会话中
 * 显式指向了一个目录。
 *
 * 例外：被管理设置（policySettings）锁定的 marketplace 插件
 * 不能被覆盖。企业管理员意图优先于本地开发便利。
 * 当会话插件与管理插件冲突时，会话副本被丢弃
 * 并返回错误以供显示。
 *
 * 没有这个去重，两个版本都在数组中，marketplace 在首次匹配时
 * 胜出，使 --plugin-dir 对于迭代已安装插件无用。
 */
export function mergePluginSources(sources: {
  session: LoadedPlugin[]
  marketplace: LoadedPlugin[]
  builtin: LoadedPlugin[]
  managedNames?: Set<string> | null
}): { plugins: LoadedPlugin[]; errors: PluginError[] } {
  const errors: PluginError[] = []
  const managed = sources.managedNames

  // 管理设置优先于 --plugin-dir。丢弃名称出现在
  // policySettings.enabledPlugins 中的会话插件（无论是强制启用
  // 还是强制禁用 — 两者都是 --plugin-dir 不应绕过的管理员意图）。
  // 暴露错误以便用户知道为什么他们的开发副本被忽略。
  //
  // 注意：managedNames 包含 pluginId 前缀（entry.name），按约定
  // 应等于 manifest.name（参见 schemas.ts PluginMarketplaceEntry.name
  // 的 schema 描述）。如果 marketplace 发布的插件中
  // entry.name ≠ manifest.name，此守卫会静默失效 —
  // 但这是 marketplace 配置错误，会破坏其他东西
  // （例如 ManagePlugins 从 manifest.name 构造 pluginIds）。
  const sessionPlugins = sources.session.filter((p) => {
    if (managed?.has(p.name)) {
      logForDebugging(`Plugin "${p.name}" from --plugin-dir is blocked by managed settings`, {
        level: 'warn',
      })
      errors.push({
        type: 'generic-error',
        source: p.source,
        plugin: p.name,
        error: `--plugin-dir copy of "${p.name}" ignored: plugin is locked by managed settings`,
      })
      return false
    }
    return true
  })

  const sessionNames = new Set(sessionPlugins.map((p) => p.name))
  const marketplacePlugins = sources.marketplace.filter((p) => {
    if (sessionNames.has(p.name)) {
      logForDebugging(`Plugin "${p.name}" from --plugin-dir overrides installed version`)
      return false
    }
    return true
  })
  // 会话优先，然后是未被覆盖的 marketplace，最后是内置。
  // 下游首次匹配的消费者对于任何通过名称过滤器的
  // 插件都会先看到会话插件而非已安装的。
  return {
    plugins: [...sessionPlugins, ...marketplacePlugins, ...sources.builtin],
    errors,
  }
}

/**
 * 主插件加载函数，发现并加载所有插件。
 *
 * 此函数被记忆化以避免重复的文件系统扫描，是插件系统的
 * 主要入口点。它从多个源发现插件并返回分类结果。
 *
 * 加载顺序和优先级（参见 mergePluginSources）：
 * 1. 仅会话插件（来自 --plugin-dir CLI 标志）— 覆盖
 *    同名的已安装插件，除非该插件被管理设置锁定
 *    （policySettings，无论是强制启用还是强制禁用）
 * 2. 基于 Marketplace 的插件（来自 settings 的 plugin@marketplace 格式）
 * 3. 随 CLI 分发的内置插件
 *
 * 名称冲突：会话插件胜过已安装的。用户在本次会话中显式
 * 指向了一个目录 — 该意图胜过已安装的内容。例外：
 * 管理设置（企业策略）优先于 --plugin-dir。
 * 管理员意图优先于本地开发便利。
 *
 * 错误收集：
 * - 非致命错误被收集并返回
 * - 系统在出错时继续加载其他插件
 * - 错误包含用于调试的源信息
 *
 * @returns 解析为分类插件结果的 Promise：
 *   - enabled：已启用的 LoadedPlugin 对象数组
 *   - disabled：已禁用的 LoadedPlugin 对象数组
 *   - errors：带有源信息的加载错误数组
 */
export const loadAllPlugins = memoize(async (): Promise<PluginLoadResult> => {
  const result = await assemblePluginLoadResult(() =>
    loadPluginsFromMarketplaces({ cacheOnly: false }),
  )
  // 新鲜的完整加载结果对仅缓存调用者也是严格有效的
  // （两个变体共享 assemblePluginLoadResult）。预热单独的
  // memoize，这样 refreshActivePlugins() 下游的 getPluginCommands() /
  // getAgentDefinitionsWithOverrides() — 现在调用
  // loadAllPluginsCacheOnly — 可以看到刚克隆的插件而不是读取
  // 会话中无人写入的 installed_plugins.json。
  loadAllPluginsCacheOnly.cache?.set(undefined, Promise.resolve(result))
  return result
})

/**
 * loadAllPlugins 的仅缓存变体。
 *
 * 相同的合并/依赖/设置逻辑，但 marketplace 加载器从不
 * 访问网络（无 cachePlugin，无 copyPluginToVersionedCache）。
 * 从 installed_plugins.json 的 installPath 读取。磁盘上不存在的插件
 * 发出 'plugin-cache-miss' 并被跳过。
 *
 * 在启动消费者（getCommands、loadPluginAgents、MCP/LSP
 * 配置）中使用此函数，这样交互式启动永远不会因跟踪 ref 的
 * 插件的 git 克隆而阻塞。在显式刷新路径（/plugins、
 * refresh.ts、headlessPluginInstall）中使用 loadAllPlugins()，
 * 其中新鲜源是意图。
 *
 * ZY_CODE_SYNC_PLUGIN_INSTALL=1 委派给完整加载器 — 该模式
 * 显式选择在首次查询前阻塞安装，且
 * main.tsx 的 getZyCodeMcpConfigs()/getInitialSettings().agent 在
 * runHeadless() 可以预热此缓存之前运行。首次运行的 CCR/headless
 * 没有 installed_plugins.json，因此仅缓存会遗漏插件 MCP 服务器
 * 和插件设置（agent 键）。交互式启动的优势得以保留，
 * 因为交互模式不设置 SYNC_PLUGIN_INSTALL。
 *
 * 与 loadAllPlugins 分开的 memoize 缓存 — 仅缓存结果绝不能
 * 满足想要新鲜源的调用者。反过来是有效的：
 * loadAllPlugins 在完成时预热此缓存，这样运行完整加载器的
 * 刷新路径不会从其下游仅缓存消费者得到 plugin-cache-miss。
 */
export const loadAllPluginsCacheOnly = memoize(async (): Promise<PluginLoadResult> => {
  if (isEnvTruthy(process.env.ZY_CODE_SYNC_PLUGIN_INSTALL)) {
    return loadAllPlugins()
  }
  return assemblePluginLoadResult(() => loadPluginsFromMarketplaces({ cacheOnly: true }))
})

/**
 * loadAllPlugins 和 loadAllPluginsCacheOnly 的共享主体。
 *
 * 两者之间唯一的区别是运行哪个 marketplace 加载器 —
 * 会话插件、内置插件、合并、verifyAndDemote 和 cachePluginSettings
 * 是相同的（不变量 1-3）。
 */
export async function assemblePluginLoadResult(
  marketplaceLoader: () => Promise<{
    plugins: LoadedPlugin[]
    errors: PluginError[]
  }>,
): Promise<PluginLoadResult> {
  // 并行加载 marketplace 插件和仅会话插件。
  // getInlinePlugins() 是同步状态读取，不依赖于
  // marketplace 加载，因此这两个源可以并发获取。
  const inlinePlugins = getInlinePlugins()
  const [marketplaceResult, sessionResult] = await Promise.all([
    marketplaceLoader(),
    inlinePlugins.length > 0
      ? loadSessionOnlyPlugins(inlinePlugins)
      : Promise.resolve({ plugins: [], errors: [] }),
  ])
  // 3. 加载随 CLI 分发的内置插件
  const builtinResult = getBuiltinPlugins()

  // 会话插件（--plugin-dir）按名称覆盖已安装的，
  // 除非已安装插件被管理设置锁定
  // （policySettings）。详见 mergePluginSources()。
  const { plugins: allPlugins, errors: mergeErrors } = mergePluginSources({
    session: sessionResult.plugins,
    marketplace: marketplaceResult.plugins,
    builtin: [...builtinResult.enabled, ...builtinResult.disabled],
    managedNames: getManagedPluginNames(),
  })
  const allErrors = [...marketplaceResult.errors, ...sessionResult.errors, ...mergeErrors]

  // 验证依赖。在并行加载之后运行 — 依赖是存在性
  // 检查，不是加载顺序，因此不需要拓扑排序。降级是
  // 会话本地的：不写入设置（用户通过 /doctor 修复意图）。
  const { demoted, errors: depErrors } = verifyAndDemote(allPlugins)
  for (const p of allPlugins) {
    if (demoted.has(p.source)) {
      p.enabled = false
    }
  }
  allErrors.push(...depErrors)

  const enabledPlugins = allPlugins.filter((p) => p.enabled)
  logForDebugging(
    `Found ${allPlugins.length} plugins (${enabledPlugins.length} enabled, ${allPlugins.length - enabledPlugins.length} disabled)`,
  )

  // 3. 缓存插件设置以供设置级联同步访问
  cachePluginSettings(enabledPlugins)

  return {
    enabled: enabledPlugins,
    disabled: allPlugins.filter((p) => !p.enabled),
    errors: allErrors,
  }
}

/**
 * 清除记忆化的插件缓存。
 *
 * 在插件安装、卸载或设置更改时调用此函数，
 * 以强制在下次 loadAllPlugins 调用时进行新的扫描。
 *
 * 使用场景：
 * - 安装/卸载插件后
 * - 修改 .zy-plugin/ 目录后（用于导出）
 * - 更改 enabledPlugins 设置后
 * - 调试插件加载问题时
 */
export function clearPluginCache(reason?: string): void {
  if (reason) {
    logForDebugging(`clearPluginCache: invalidating loadAllPlugins cache (${reason})`)
  }
  loadAllPlugins.cache?.clear?.()
  loadAllPluginsCacheOnly.cache?.clear?.()
  // 如果插件之前贡献了设置，会话设置缓存保存了包含它们的
  // 合并结果。重新加载时的 cachePluginSettings() 在新基础为空时
  // 不会清除缓存（启动性能优化），所以在这里清除以丢弃
  // 过时的插件覆盖。当基础已是 undefined（启动时，或之前
  // 无插件设置）时这是空操作。
  if (getPluginSettingsBase() !== undefined) {
    resetSettingsCache()
  }
  clearPluginSettingsBase()
  // TODO: 当 installedPluginsManager 实现时清除已安装插件缓存
}

/**
 * 将所有已启用插件的设置合并为单个记录。
 * 后面的插件对相同的键覆盖前面的。
 * 仅包含白名单中的键（过滤在加载时发生）。
 */
export function mergePluginSettings(plugins: LoadedPlugin[]): Record<string, unknown> | undefined {
  let merged: Record<string, unknown> | undefined

  for (const plugin of plugins) {
    if (!plugin.settings) {
      continue
    }

    if (!merged) {
      merged = {}
    }

    for (const [key, value] of Object.entries(plugin.settings)) {
      if (key in merged) {
        logForDebugging(
          `Plugin "${plugin.name}" overrides setting "${key}" (previously set by another plugin)`,
        )
      }
      merged[key] = value
    }
  }

  return merged
}

/**
 * 将合并的插件设置存储在同步缓存中。
 * 在 loadAllPlugins 解析后调用。
 */
export function cachePluginSettings(plugins: LoadedPlugin[]): void {
  const settings = mergePluginSettings(plugins)
  setPluginSettingsBase(settings)
  // 仅在实际有插件设置需要合并时才清除会话设置缓存。
  // 在常见情况下（无插件，或插件无设置）基础层为空，
  // loadSettingsFromDisk 无论如何都会产生相同的结果 —
  // 在这里重置会在下次 getSettingsWithErrors() 调用时浪费
  // 约 17ms 用于启动时重新读取和重新验证每个设置文件。
  if (settings && Object.keys(settings).length > 0) {
    resetSettingsCache()
    logForDebugging(`Cached plugin settings with keys: ${Object.keys(settings).join(', ')}`)
  }
}

/**
 * 类型谓词：检查值是否为非 null、非数组的对象（即记录）。
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
