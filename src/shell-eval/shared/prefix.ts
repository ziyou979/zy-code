/**
 * 使用轻量模型的共享命令前缀提取模块
 *
 * 本模块提供了创建命令前缀提取器的工厂方法，
 * 可供不同的 shell 工具使用。核心逻辑（轻量模型查询、响应验证）是共享的，
 * 而工具特定的方面（示例、预检查）是可配置的。
 */

import chalk from 'chalk'
import type { QuerySource } from '../../constants/querySource.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { startsWithApiErrorPrefix } from '../../services/api/errors.js'
import { queryCompactModel } from '../../services/api/compactQueries.js'
import { memoizeWithLRU } from '../../utils/memoize.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { asSystemPrompt } from '../../utils/systemPromptType.js'

/**
 * 绝不能作为裸前缀接受的 shell 可执行文件。
 * 允许如 "bash:*" 会让任何命令通过，从而绕过权限系统。
 * 包含 Unix shell 和 Windows 等效项。
 */
const DANGEROUS_SHELL_PREFIXES = new Set([
  'sh',
  'bash',
  'zsh',
  'fish',
  'csh',
  'tcsh',
  'ksh',
  'dash',
  'cmd',
  'cmd.exe',
  'powershell',
  'powershell.exe',
  'pwsh',
  'pwsh.exe',
  'bash.exe',
])

/**
 * 命令前缀提取的结果
 */
export type CommandPrefixResult = {
  /** 检测到的命令前缀，如果无法确定前缀则为 null */
  commandPrefix: string | null
}

/**
 * 包含复合命令子命令前缀的结果
 */
export type CommandSubcommandPrefixResult = CommandPrefixResult & {
  subcommandPrefixes: Map<string, CommandPrefixResult>
}

/**
 * 创建命令前缀提取器的配置
 */
export type PrefixExtractorConfig = {
  /** 用于日志和警告消息的工具名称 */
  toolName: string

  /** The policy spec containing examples for Haiku */
  policySpec: string
  /** 用于日志记录的分析事件名称 */
  eventName: string

  /** API 调用的查询来源标识符 */
  querySource: QuerySource

  /** 可选的预检查函数，可短路 Haiku 调用 */
  preCheck?: (command: string) => CommandPrefixResult | null
}

/**
 * 创建一个被记忆化的命令前缀提取器函数。
 *
 * 使用两层记忆化：外层记忆化函数创建 promise 并附加 .catch 处理器，
 * 在拒绝时清除缓存条目。这可以防止中止或失败的 Haiku 调用污染后续查找。
 *
 * 通过 LRU 限制为 200 个条目，防止在高负载会话中无限增长。
 *
 * @param config - 提取器的配置
 * @returns 一个提取命令前缀的记忆化异步函数
 */
export function createCommandPrefixExtractor(config: PrefixExtractorConfig) {
  const { toolName, policySpec, eventName, querySource, preCheck } = config

  const memoized = memoizeWithLRU(
    (
      command: string,
      abortSignal: AbortSignal,
      isNonInteractiveSession: boolean,
    ): Promise<CommandPrefixResult | null> => {
      const promise = getCommandPrefixImpl(
        command,
        abortSignal,
        isNonInteractiveSession,
        toolName,
        policySpec,
        eventName,
        querySource,
        preCheck,
      )
      // 拒绝时清除缓存，防止中止的调用污染后续轮次。
      // 身份守卫：LRU 淘汰后，一个更新的 promise 可能占据此 key；
      // 过期的拒绝不能删除它。
      promise.catch(() => {
        if (memoized.cache.get(command) === promise) {
          memoized.cache.delete(command)
        }
      })
      return promise
    },
    (command) => command, // 仅按命令进行记忆化
    200,
  )

  return memoized
}

/**
 * 创建一个被记忆化的函数，用于获取包含子命令的复合命令的前缀。
 *
 * 使用与 createCommandPrefixExtractor 相同的两层记忆化模式：
 * .catch 处理器在拒绝时清除缓存条目以防止污染。
 *
 * @param getPrefix - 单命令前缀提取器（来自 createCommandPrefixExtractor）
 * @param splitCommand - 将复合命令拆分为子命令的函数
 * @returns 一个提取主命令和所有子命令前缀的记忆化异步函数
 */
export function createSubcommandPrefixExtractor(
  getPrefix: ReturnType<typeof createCommandPrefixExtractor>,
  splitCommand: (command: string) => string[] | Promise<string[]>,
) {
  const memoized = memoizeWithLRU(
    (
      command: string,
      abortSignal: AbortSignal,
      isNonInteractiveSession: boolean,
    ): Promise<CommandSubcommandPrefixResult | null> => {
      const promise = getCommandSubcommandPrefixImpl(
        command,
        abortSignal,
        isNonInteractiveSession,
        getPrefix,
        splitCommand,
      )
      // 拒绝时清除缓存，防止中止的调用污染后续轮次。
      // 身份守卫：LRU 淘汰后，一个更新的 promise 可能占据此 key；
      // 过期的拒绝不能删除它。
      promise.catch(() => {
        if (memoized.cache.get(command) === promise) {
          memoized.cache.delete(command)
        }
      })
      return promise
    },
    (command) => command, // 仅按命令进行记忆化
    200,
  )

  return memoized
}

async function getCommandPrefixImpl(
  command: string,
  abortSignal: AbortSignal,
  isNonInteractiveSession: boolean,
  toolName: string,
  policySpec: string,
  eventName: string,
  querySource: QuerySource,
  preCheck?: (command: string) => CommandPrefixResult | null,
): Promise<CommandPrefixResult | null> {
  if (process.env.NODE_ENV === 'test') {
    return null
  }

  // 如果提供了预检查则执行（例如 Bash 的 isHelpCommand）
  if (preCheck) {
    const preCheckResult = preCheck(command)
    if (preCheckResult !== null) {
      return preCheckResult
    }
  }

  let preflightCheckTimeoutId: NodeJS.Timeout | undefined
  const startTime = Date.now()
  let result: CommandPrefixResult | null = null

  try {
    // 如果预检查耗时过长则记录警告
    preflightCheckTimeoutId = setTimeout(
      (tn, nonInteractive) => {
        const message = `[${tn}Tool] Pre-flight check is taking longer than expected. Run with ANTHROPIC_LOG=debug to check for failed or slow API requests.`
        if (nonInteractive) {
          process.stderr.write(`${jsonStringify({ level: 'warn', message })}\n`)
        } else {
          // biome-ignore lint/suspicious/noConsole: intentional warning
          console.warn(chalk.yellow(`⚠️  ${message}`))
        }
      },
      10000, // 10 seconds
      toolName,
      isNonInteractiveSession,
    )

    const useSystemPromptPolicySpec = getFeatureValue_CACHED_MAY_BE_STALE('zy_cork_m4q', false)

    const response = await queryCompactModel({
      systemPrompt: asSystemPrompt(
        useSystemPromptPolicySpec
          ? [
              `Your task is to process ${toolName} commands that an AI coding agent wants to run.\n\n${policySpec}`,
            ]
          : [
              `Your task is to process ${toolName} commands that an AI coding agent wants to run.\n\nThis policy spec defines how to determine the prefix of a ${toolName} command:`,
            ],
      ),
      userPrompt: useSystemPromptPolicySpec
        ? `Command: ${command}`
        : `${policySpec}\n\nCommand: ${command}`,
      signal: abortSignal,
      options: {
        enablePromptCaching: useSystemPromptPolicySpec,
        querySource,
        agents: [],
        isNonInteractiveSession,
        hasAppendSystemPrompt: false,
        mcpTools: [],
      },
    })

    // 查询已完成，清除超时定时器
    clearTimeout(preflightCheckTimeoutId)
    const durationMs = Date.now() - startTime

    const prefix =
      typeof response.message.content === 'string'
        ? response.message.content
        : Array.isArray(response.message.content)
          ? (response.message.content.find((_) => _.type === 'text')?.text ?? 'none')
          : 'none'

    if (startsWithApiErrorPrefix(prefix)) {
      logEvent(eventName, {
        success: false,
        error: 'API error' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        durationMs,
      })
      result = null
    } else if (prefix === 'command_injection_detected') {
      // Haiku 检测到可疑内容 - 视为无可用前缀
      logEvent(eventName, {
        success: false,
        error:
          'command_injection_detected' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        durationMs,
      })
      result = {
        commandPrefix: null,
      }
    } else if (prefix === 'git' || DANGEROUS_SHELL_PREFIXES.has(prefix.toLowerCase())) {
      // 永远不接受裸 `git` 或 shell 可执行文件作为前缀
      logEvent(eventName, {
        success: false,
        error:
          'dangerous_shell_prefix' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        durationMs,
      })
      result = {
        commandPrefix: null,
      }
    } else if (prefix === 'none') {
      // 未检测到前缀
      logEvent(eventName, {
        success: false,
        error: 'prefix "none"' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        durationMs,
      })
      result = {
        commandPrefix: null,
      }
    } else {
      // 验证前缀确实是命令的前缀

      if (!command.startsWith(prefix)) {
        // 前缀实际上不是命令的前缀
        logEvent(eventName, {
          success: false,
          error:
            'command did not start with prefix' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          durationMs,
        })
        result = {
          commandPrefix: null,
        }
      } else {
        logEvent(eventName, {
          success: true,
          durationMs,
        })
        result = {
          commandPrefix: prefix,
        }
      }
    }

    return result
  } catch (error) {
    clearTimeout(preflightCheckTimeoutId)
    throw error
  }
}

async function getCommandSubcommandPrefixImpl(
  command: string,
  abortSignal: AbortSignal,
  isNonInteractiveSession: boolean,
  getPrefix: ReturnType<typeof createCommandPrefixExtractor>,
  splitCommandFn: (command: string) => string[] | Promise<string[]>,
): Promise<CommandSubcommandPrefixResult | null> {
  const subcommands = await splitCommandFn(command)

  const [fullCommandPrefix, ...subcommandPrefixesResults] = await Promise.all([
    getPrefix(command, abortSignal, isNonInteractiveSession),
    ...subcommands.map(async (subcommand) => ({
      subcommand,
      prefix: await getPrefix(subcommand, abortSignal, isNonInteractiveSession),
    })),
  ])

  if (!fullCommandPrefix) {
    return null
  }

  const subcommandPrefixes = subcommandPrefixesResults.reduce((acc, { subcommand, prefix }) => {
    if (prefix) {
      acc.set(subcommand, prefix)
    }
    return acc
  }, new Map<string, CommandPrefixResult>())

  return {
    ...fullCommandPrefix,
    subcommandPrefixes,
  }
}
