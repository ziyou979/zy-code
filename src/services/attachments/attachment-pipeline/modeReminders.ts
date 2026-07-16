// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import {
  logEvent,
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
} from 'src/services/analytics/index.js'
import {
  toolMatchesName,
  type Tools,
  type ToolUseContext,
  type ToolPermissionContext,
} from '../../../tool.js'
import { FileReadTool, readImageWithTokenBudget } from '../../../tools/FileReadTool/FileReadTool.js'
import { expandPath } from '../../../utils/path.js'
import { readdir, stat } from 'node:fs/promises'
import type { IDESelection } from '../../../hooks/useIdeSelection.js'
import { getConnectedIdeName } from '../../ide/ide.js'
import {
  getManagedAndUserConditionalRules,
  getMemoryFilesForNestedDirectory,
  getConditionalRulesForCwdLevelDirectory,
  type MemoryFileInfo,
} from '../../../utils/agentsMd.js'
import { dirname, parse, relative, resolve } from 'node:path'
import { getCwd } from 'src/utils/cwd.js'
import { logError } from '../../../utils/log.js'
import { isENOENT } from '../../../utils/errors.js'
import type { Message } from 'src/types/message.js'
import { getInitialSettings } from '../../settings/settings.js'
import { getSnippetForTwoFileDiff } from 'src/tools/FileEditTool/utils.js'
import { cacheKeys } from '../../../utils/fileStateCache.js'
import { getFileModificationTimeAsync } from '../../../utils/file.js'
import type { AgentDefinition } from '../../../tools/AgentTool/loadAgentsDir.js'
import { filterAgentsByMcpRequirements } from '../../../tools/AgentTool/loadAgentsDir.js'
import { AGENT_TOOL_NAME } from '../../../tools/AgentTool/constants.js'
import {
  formatAgentLine,
  shouldInjectAgentListInMessages,
} from '../../../tools/AgentTool/prompt.js'
import { filterDeniedAgents } from '../../permissions/permissions.js'
import { mcpInfoFromString } from '../../mcp/mcpStringUtils.js'
import { pathInAllowedWorkingPath } from '../../permissions/filesystem.js'
import { getOriginalCwd } from '../../../bootstrap/runtime/runtimeContext.js'
import {
  getDeferredToolsDelta,
  isDeferredToolsDeltaEnabled,
  isToolSearchEnabledOptimistic,
  isToolSearchToolAvailable,
  modelSupportsToolReference,
  type DeferredToolsDeltaScanContext,
} from '../../../utils/toolSearch.js'
import {
  getMcpInstructionsDelta,
  isMcpInstructionsDeltaEnabled,
  type ClientSideInstruction,
} from '../../../utils/mcpInstructionsDelta.js'
import { CLAUDE_IN_CHROME_MCP_SERVER_NAME } from 'src/services/claude-in-chrome/common.js'
import { CHROME_TOOL_SEARCH_INSTRUCTIONS } from 'src/services/claude-in-chrome/prompt.js'
import type { MCPServerConnection } from '../../mcp/types.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../analytics/growthbook.js'
import {
  hasInstructionsLoadedHook,
  executeInstructionsLoadedHooks,
  type InstructionsMemoryType,
} from '../../hooks.js'
import { Attachment } from './types.js'
import {
  extractAgentMentions,
  extractAtMentionedFiles,
  extractMcpResourceMentions,
  parseAtMentionedFileLines,
} from './contextDelta.js'
import { generateFileAttachment } from './memory.js'
import { isFileReadDenied } from './skills.js'
// 为 compact.ts 导出 — 门控在两个调用点必须一致。
export function getDeferredToolsDeltaAttachment(
  tools: Tools,
  model: string,
  messages: Message[] | undefined,
  scanContext?: DeferredToolsDeltaScanContext,
): Attachment[] {
  if (!isDeferredToolsDeltaEnabled()) {
    return []
  }
  // 这三个检查与 isToolSearchEnabled 的同步部分镜像 —
  // 附件文本说 "available via ToolSearch"，因此 ToolSearch
  // 必须实际存在于请求中。异步 auto-threshold 检查不复制
  //（会重复触发 zy_tool_search_mode_decision）；
  // 在 tst-auto 低于阈值时，附件可能在 ToolSearch 被过滤后触发，
  // 但这是窄情况，且宣布的工具无论如何都是可直接调用的。
  if (!isToolSearchEnabledOptimistic()) {
    return []
  }
  if (!modelSupportsToolReference(model)) {
    return []
  }
  if (!isToolSearchToolAvailable(tools)) {
    return []
  }
  const delta = getDeferredToolsDelta(tools, messages ?? [], scanContext)
  if (!delta) {
    return []
  }
  return [
    {
      type: 'deferred_tools_delta',
      ...delta,
    },
  ]
}

/**
 * 对比当前过滤后的 agent 池与此对话中已公告的内容
 *（从之前的 agent_listing_delta 附件重建）。如果无变化或 gate 关闭则返回 []。
 *
 * agent 列表之前嵌入在 AgentTool 的 description 中，导致约 10.2% 的
 * 全量 cache_creation：MCP 异步连接、/reload-plugins 或权限模式变更
 * → description 变化 → 完整 tool-schema 缓存失效。
 * 将列表移到此处使工具 description 保持静态。
 *
 * 导出供 compact.ts 使用——在压缩吞噬先前 delta 后重新公告完整集合。
 */
export function getAgentListingDeltaAttachment(
  toolUseContext: ToolUseContext,
  messages: Message[] | undefined,
): Attachment[] {
  if (!shouldInjectAgentListInMessages()) {
    return []
  }

  // 如果 AgentTool 不在池中则跳过 — 列表将无法操作。
  if (!toolUseContext.options.tools.some((t) => toolMatchesName(t, AGENT_TOOL_NAME))) {
    return []
  }
  const { activeAgents, allowedAgentTypes } = toolUseContext.options.agentDefinitions

  // 镜像 AgentTool.prompt() 的过滤：MCP 要求 → 拒绝规则 → allowedAgentTypes 限制。
  // 与 AgentTool.tsx 保持同步。
  const mcpServers = new Set<string>()
  for (const tool of toolUseContext.options.tools) {
    const info = mcpInfoFromString(tool.name)
    if (info) {
      mcpServers.add(info.serverName)
    }
  }
  const permissionContext = toolUseContext.getAppState().toolPermissionContext
  let filtered = filterDeniedAgents(
    filterAgentsByMcpRequirements(activeAgents, [...mcpServers]),
    permissionContext,
    AGENT_TOOL_NAME,
  )
  if (allowedAgentTypes) {
    filtered = filtered.filter((a) => allowedAgentTypes.includes(a.agentType))
  }

  // 从 transcript 中的先前增量重建已宣布集合。
  const announced = new Set<string>()
  for (const msg of messages ?? []) {
    if (msg.type !== 'attachment') {
      continue
    }
    if (msg.attachment.type !== 'agent_listing_delta') {
      continue
    }
    // biome-ignore lint/suspicious/noExplicitAny: 运行时动态类型处理
    for (const t of (msg.attachment as unknown as { addedTypes: string[] }).addedTypes) {
      announced.add(t)
    }
    // biome-ignore lint/suspicious/noExplicitAny: 运行时动态类型处理
    for (const t of (msg.attachment as unknown as { removedTypes: string[] }).removedTypes) {
      announced.delete(t)
    }
  }
  const currentTypes = new Set(filtered.map((a) => a.agentType))
  const added = filtered.filter((a) => !announced.has(a.agentType))
  const removed: string[] = []
  for (const t of announced) {
    if (!currentTypes.has(t)) {
      removed.push(t)
    }
  }
  if (added.length === 0 && removed.length === 0) {
    return []
  }

  // 排序以获得确定性输出 — agent 加载顺序是非确定性的
  //（插件加载竞争、MCP 异步连接）。
  added.sort((a, b) => a.agentType.localeCompare(b.agentType))
  removed.sort()
  return [
    {
      type: 'agent_listing_delta',
      addedTypes: added.map((a) => a.agentType),
      addedLines: added.map(formatAgentLine),
      removedTypes: removed,
      isInitial: announced.size === 0,
      showConcurrencyNote: true,
    },
  ]
}

// 为 compact.ts / reactiveCompact.ts 导出 — 门控的唯一真实来源。
export function getMcpInstructionsDeltaAttachment(
  mcpClients: MCPServerConnection[],
  tools: Tools,
  model: string,
  messages: Message[] | undefined,
): Attachment[] {
  if (!isMcpInstructionsDeltaEnabled()) {
    return []
  }

  // chrome ToolSearch 提示是客户端编写且 ToolSearch 条件性的；
  // 实际服务器 `instructions` 是无条件的。在此决定 chrome 部分，
  // 将其作为合成条目传入纯 diff。
  const clientSide: ClientSideInstruction[] = []
  if (
    isToolSearchEnabledOptimistic() &&
    modelSupportsToolReference(model) &&
    isToolSearchToolAvailable(tools)
  ) {
    clientSide.push({
      serverName: CLAUDE_IN_CHROME_MCP_SERVER_NAME,
      block: CHROME_TOOL_SEARCH_INSTRUCTIONS,
    })
  }
  const delta = getMcpInstructionsDelta(mcpClients, messages ?? [], clientSide)
  if (!delta) {
    return []
  }
  return [
    {
      type: 'mcp_instructions_delta',
      ...delta,
    },
  ]
}

export function getCriticalSystemReminderAttachment(toolUseContext: ToolUseContext): Attachment[] {
  const reminder = toolUseContext.criticalSystemReminder_EXPERIMENTAL
  if (!reminder) {
    return []
  }
  return [
    {
      type: 'critical_system_reminder',
      content: reminder,
    },
  ]
}

export function getOutputStyleAttachment(): Attachment[] {
  const settings = getInitialSettings()
  const outputStyle = settings?.outputStyle || 'default'

  // 仅对非默认样式显示
  if (outputStyle === 'default') {
    return []
  }
  return [
    {
      type: 'output_style',
      style: outputStyle,
    },
  ]
}

export async function getSelectedLinesFromIDE(
  ideSelection: IDESelection | null,
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  const ideName = getConnectedIdeName(toolUseContext.options.mcpClients)
  if (
    !ideName ||
    ideSelection?.lineStart === undefined ||
    !ideSelection.text ||
    !ideSelection.filePath
  ) {
    return []
  }
  const appState = toolUseContext.getAppState()
  if (isFileReadDenied(ideSelection.filePath, appState.toolPermissionContext)) {
    return []
  }
  return [
    {
      type: 'selected_lines_in_ide',
      ideName,
      lineStart: ideSelection.lineStart,
      lineEnd: ideSelection.lineStart + ideSelection.lineCount - 1,
      filename: ideSelection.filePath,
      content: ideSelection.text,
      displayPath: relative(getCwd(), ideSelection.filePath),
    },
  ]
}

/**
 * Computes the directories to process for nested memory file loading.
 * Returns two lists:
 * - nestedDirs: Directories between CWD and targetPath (processed for AGENTS.md + all rules)
 * - cwdLevelDirs: Directories from root to CWD (processed for conditional rules only)
 *
 * @param targetPath The target file path
 * @param originalCwd The original current working directory
 * @returns Object with nestedDirs and cwdLevelDirs arrays, both ordered from parent to child
 */
export function getDirectoriesToProcess(
  targetPath: string,
  originalCwd: string,
): {
  nestedDirs: string[]
  cwdLevelDirs: string[]
} {
  // 构建从原始 CWD 到 targetPath 目录的目录列表
  const targetDir = dirname(resolve(targetPath))
  const nestedDirs: string[] = []
  let currentDir = targetDir

  // 从目标目录向上遍历到原始 CWD
  while (currentDir !== originalCwd && currentDir !== parse(currentDir).root) {
    if (currentDir.startsWith(originalCwd)) {
      nestedDirs.push(currentDir)
    }
    currentDir = dirname(currentDir)
  }

  // 反转以获得从 CWD 到目标的顺序
  nestedDirs.reverse()

  // 构建从根目录到 CWD 的目录列表（仅用于条件规则）
  const cwdLevelDirs: string[] = []
  currentDir = originalCwd
  while (currentDir !== parse(currentDir).root) {
    cwdLevelDirs.push(currentDir)
    currentDir = dirname(currentDir)
  }

  // 反转以获得从根目录到 CWD 的顺序
  cwdLevelDirs.reverse()
  return {
    nestedDirs,
    cwdLevelDirs,
  }
}

/**
 * 将内存文件转换为附件，过滤掉已加载的文件。
 *
 * @param memoryFiles 要转换的内存文件
 * @param toolUseContext 工具使用上下文（用于追踪已加载的文件）
 * @returns 嵌套内存附件数组
 */
export function isInstructionsMemoryType(
  type: MemoryFileInfo['type'],
): type is InstructionsMemoryType {
  return type === 'User' || type === 'Project' || type === 'Local' || type === 'Managed'
}

/** 导出用于测试——LRU 淘汰重新注入的回归保护。 */
export function memoryFilesToAttachments(
  memoryFiles: MemoryFileInfo[],
  toolUseContext: ToolUseContext,
  triggerFilePath?: string,
): Attachment[] {
  const attachments: Attachment[] = []
  const shouldFireHook = hasInstructionsLoadedHook()
  for (const memoryFile of memoryFiles) {
    // 去重：loadedNestedMemoryPaths 是非淘汰 Set；
    // readFileState 是 100 条目 LRU，在繁忙会话中会丢弃条目，
    // 因此仅依赖它会在每次淘汰周期重新注入相同的 AGENTS.md。
    if (toolUseContext.loadedNestedMemoryPaths?.has(memoryFile.path)) {
      continue
    }
    if (!toolUseContext.readFileState.has(memoryFile.path)) {
      attachments.push({
        type: 'nested_memory',
        path: memoryFile.path,
        content: memoryFile,
        displayPath: relative(getCwd(), memoryFile.path),
      })
      toolUseContext.loadedNestedMemoryPaths?.add(memoryFile.path)

      // 在 readFileState 中标记为已加载 — 通过上方的 .has() 检查提供
      // 跨函数和跨轮次去重。
      //
      // 当注入的内容与磁盘不匹配（剥离的 HTML 注释、
      // 剥离的 frontmatter、截断的 MEMORY.md）时，用 `isPartialView: true`
      // 缓存原始磁盘字节。编辑/写入看到该标志并要求先进行真实读取；
      // getChangedFiles 看到真实内容 + undefined offset/limit，
      // 因此会话中期的更改检测仍然有效。
      toolUseContext.readFileState.set(memoryFile.path, {
        content: memoryFile.contentDiffersFromDisk
          ? (memoryFile.rawContent ?? memoryFile.content)
          : memoryFile.content,
        timestamp: Date.now(),
        offset: undefined,
        limit: undefined,
        isPartialView: memoryFile.contentDiffersFromDisk,
      })

      // 触发 InstructionsLoaded hook 用于审计/可观测性（触发即忘）
      if (shouldFireHook && isInstructionsMemoryType(memoryFile.type)) {
        const loadReason = memoryFile.globs
          ? 'path_glob_match'
          : memoryFile.parent
            ? 'include'
            : 'nested_traversal'
        void executeInstructionsLoadedHooks(memoryFile.path, memoryFile.type, loadReason, {
          globs: memoryFile.globs,
          triggerFilePath,
          parentFilePath: memoryFile.parent,
        })
      }
    }
  }
  return attachments
}

/**
 * 为给定文件路径加载嵌套内存文件并将其作为附件返回。
 * 此函数执行目录遍历以查找适用于目标文件路径的 AGENTS.md 文件和条件规则。
 *
 * 处理顺序（必须保持）：
 * 1. 匹配 targetPath 的 Managed/User 条件规则
 * 2. 嵌套目录（CWD → target）：AGENTS.md + 无条件规则 + 条件规则
 * 3. CWD 级目录（root → CWD）：仅条件规则
 *
 * @param filePath 要获取嵌套内存文件的文件路径
 * @param toolUseContext 工具使用上下文
 * @param appState 包含工具权限上下文的应用状态
 * @returns 嵌套内存附件数组
 */
export async function getNestedMemoryAttachmentsForFile(
  filePath: string,
  toolUseContext: ToolUseContext,
  appState: {
    toolPermissionContext: ToolPermissionContext
  },
): Promise<Attachment[]> {
  const attachments: Attachment[] = []
  try {
    // 如果路径不在允许的工作路径中，提前返回
    if (!pathInAllowedWorkingPath(filePath, appState.toolPermissionContext)) {
      return attachments
    }
    const processedPaths = new Set<string>()
    const originalCwd = getOriginalCwd()

    // 阶段 1：处理 Managed 和 User 条件规则
    const managedUserRules = await getManagedAndUserConditionalRules(filePath, processedPaths)
    attachments.push(...memoryFilesToAttachments(managedUserRules, toolUseContext, filePath))

    // 阶段 2：获取要处理的目录
    const { nestedDirs, cwdLevelDirs } = getDirectoriesToProcess(filePath, originalCwd)
    const skipProjectLevel = getFeatureValue_CACHED_MAY_BE_STALE('zy_paper_halyard', false)

    // 阶段 3：处理嵌套目录（CWD → target）
    // 每个目录获取：AGENTS.md + 无条件规则 + 条件规则
    for (const dir of nestedDirs) {
      const memoryFiles = (
        await getMemoryFilesForNestedDirectory(dir, filePath, processedPaths)
      ).filter((f) => !skipProjectLevel || (f.type !== 'Project' && f.type !== 'Local'))
      attachments.push(...memoryFilesToAttachments(memoryFiles, toolUseContext, filePath))
    }

    // 阶段 4：处理 CWD 级目录（root → CWD）
    // 仅条件规则（无条件规则已预先热加载）
    for (const dir of cwdLevelDirs) {
      const conditionalRules = (
        await getConditionalRulesForCwdLevelDirectory(dir, filePath, processedPaths)
      ).filter((f) => !skipProjectLevel || (f.type !== 'Project' && f.type !== 'Local'))
      attachments.push(...memoryFilesToAttachments(conditionalRules, toolUseContext, filePath))
    }
  } catch (error) {
    logError(error)
  }
  return attachments
}

export async function getOpenedFileFromIDE(
  ideSelection: IDESelection | null,
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  if (!ideSelection?.filePath || ideSelection.text) {
    return []
  }
  const appState = toolUseContext.getAppState()
  if (isFileReadDenied(ideSelection.filePath, appState.toolPermissionContext)) {
    return []
  }

  // 获取嵌套记忆文件
  const nestedMemoryAttachments = await getNestedMemoryAttachmentsForFile(
    ideSelection.filePath,
    toolUseContext,
    appState,
  )

  // 返回嵌套记忆附件，然后是打开的文件附件
  return [
    ...nestedMemoryAttachments,
    {
      type: 'opened_file_in_ide',
      filename: ideSelection.filePath,
    },
  ]
}

export async function processAtMentionedFiles(
  input: string,
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  const files = extractAtMentionedFiles(input)
  if (files.length === 0) {
    return []
  }
  const appState = toolUseContext.getAppState()
  const results = await Promise.all(
    files.map(async (file) => {
      try {
        const { filename, lineStart, lineEnd } = parseAtMentionedFileLines(file)
        const absoluteFilename = expandPath(filename)
        if (isFileReadDenied(absoluteFilename, appState.toolPermissionContext)) {
          return null
        }

        // 检查是否是目录
        try {
          const stats = await stat(absoluteFilename)
          if (stats.isDirectory()) {
            try {
              const entries = await readdir(absoluteFilename, {
                withFileTypes: true,
              })
              const MAX_DIR_ENTRIES = 1000
              const truncated = entries.length > MAX_DIR_ENTRIES
              const names = entries.slice(0, MAX_DIR_ENTRIES).map((e) => e.name)
              if (truncated) {
                names.push(`\u2026 and ${entries.length - MAX_DIR_ENTRIES} more entries`)
              }
              const stdout = names.join('\n')
              logEvent('zy_at_mention_extracting_directory_success', {})
              return {
                type: 'directory' as const,
                path: absoluteFilename,
                content: stdout,
                displayPath: relative(getCwd(), absoluteFilename),
              }
            } catch {
              return null
            }
          }
        } catch {
          // 如果 stat 失败，继续执行文件逻辑
        }
        return await generateFileAttachment(
          absoluteFilename,
          toolUseContext,
          'zy_at_mention_extracting_filename_success',
          'zy_at_mention_extracting_filename_error',
          'at-mention',
          {
            offset: lineStart,
            limit: lineEnd && lineStart ? lineEnd - lineStart + 1 : undefined,
          },
        )
      } catch {
        logEvent('zy_at_mention_extracting_filename_error', {})
      }
    }),
  )
  return results.filter(Boolean) as Attachment[]
}

export function processAgentMentions(input: string, agents: AgentDefinition[]): Attachment[] {
  const agentMentions = extractAgentMentions(input)
  if (agentMentions.length === 0) {
    return []
  }
  const results = agentMentions.map((mention) => {
    const agentType = mention.replace('agent-', '')
    const agentDef = agents.find((def) => def.agentType === agentType)
    if (!agentDef) {
      logEvent('zy_at_mention_agent_not_found', {})
      return null
    }
    logEvent('zy_at_mention_agent_success', {})
    return {
      type: 'agent_mention' as const,
      agentType: agentDef.agentType,
    }
  })
  return results.filter((result): result is NonNullable<typeof result> => result !== null)
}

export async function processMcpResourceAttachments(
  input: string,
  toolUseContext: ToolUseContext,
): Promise<Attachment[]> {
  const resourceMentions = extractMcpResourceMentions(input)
  if (resourceMentions.length === 0) {
    return []
  }
  const mcpClients = toolUseContext.options.mcpClients || []
  const results = await Promise.all(
    resourceMentions.map(async (mention) => {
      try {
        const [serverName, ...uriParts] = mention.split(':')
        const uri = uriParts.join(':') // 重新连接，以防 URI 包含冒号

        if (!serverName || !uri) {
          logEvent('zy_at_mention_mcp_resource_error', {})
          return null
        }

        // 查找 MCP 客户端
        const client = mcpClients.find((c) => c.name === serverName)
        if (client?.type !== 'connected') {
          logEvent('zy_at_mention_mcp_resource_error', {})
          return null
        }

        // 在可用资源中查找资源以获取其元数据
        const serverResources = toolUseContext.options.mcpResources?.[serverName] || []
        const resourceInfo = serverResources.find((r) => r.uri === uri)
        if (!resourceInfo) {
          logEvent('zy_at_mention_mcp_resource_error', {})
          return null
        }
        try {
          const result = await client.client.readResource({
            uri,
          })
          logEvent('zy_at_mention_mcp_resource_success', {})
          return {
            type: 'mcp_resource' as const,
            server: serverName,
            uri,
            name: resourceInfo.name || uri,
            description: resourceInfo.description,
            content: result,
          }
        } catch (error) {
          logEvent('zy_at_mention_mcp_resource_error', {})
          logError(error)
          return null
        }
      } catch {
        logEvent('zy_at_mention_mcp_resource_error', {})
        return null
      }
    }),
  )
  return results.filter(
    (result): result is NonNullable<typeof result> => result !== null,
  ) as Attachment[]
}

export async function getChangedFiles(toolUseContext: ToolUseContext): Promise<Attachment[]> {
  const filePaths = cacheKeys(toolUseContext.readFileState)
  if (filePaths.length === 0) {
    return []
  }
  const appState = toolUseContext.getAppState()
  const results = await Promise.all(
    filePaths.map(async (filePath) => {
      const fileState = toolUseContext.readFileState.get(filePath)
      if (!fileState) {
        return null
      }

      // TODO：实现 changed files 的 offset/limit 支持
      if (fileState.offset !== undefined || fileState.limit !== undefined) {
        return null
      }
      const normalizedPath = expandPath(filePath)

      // 检查文件是否配置了拒绝规则
      if (isFileReadDenied(normalizedPath, appState.toolPermissionContext)) {
        return null
      }
      try {
        const mtime = await getFileModificationTimeAsync(normalizedPath)
        if (mtime <= fileState.timestamp) {
          return null
        }
        const fileInput = {
          file_path: normalizedPath,
        }

        // 验证文件路径有效
        const isValid = await FileReadTool.validateInput(fileInput, toolUseContext)
        if (!isValid.result) {
          return null
        }
        const result = await FileReadTool.call(fileInput, toolUseContext)
        // 仅提取更改的部分
        if (result.data.type === 'text') {
          const snippet = getSnippetForTwoFileDiff(fileState.content, result.data.file.content)

          // 文件被触及但未修改
          if (snippet === '') {
            return null
          }
          return {
            type: 'edited_text_file' as const,
            filename: normalizedPath,
            snippet,
          }
        }

        // 对于非文本文件（图片），应用与 FileReadTool 相同的 token 限制逻辑
        if (result.data.type === 'image') {
          try {
            const data = await readImageWithTokenBudget(normalizedPath)
            return {
              type: 'edited_image_file' as const,
              filename: normalizedPath,
              content: data,
            }
          } catch (compressionError) {
            logError(compressionError)
            logEvent('zy_watched_file_compression_failed', {
              file: normalizedPath,
            } as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS)
            return null
          }
        }

        // notebook / pdf / parts — 无差异表示；显式返回 null，
        // 使 map 回调没有隐式 undefined 路径。
        return null
      } catch (err) {
        // 仅在 ENOENT 时淘汰（文件真正删除）。瞬时 stat 失败 —
        // 原子保存竞争（编辑器写入 tmp→rename 且 stat 命中间隙）、
        // EACCES 变动、网络 FS 抖动 — 绝不能淘汰，否则下次 Edit
        // 会 code-6 失败，尽管文件仍然存在且模型刚读取过它。
        // VS Code 自动保存/保存时格式化尤其频繁命中此竞争。
        // 见 PR #18525 的回归分析。
        if (isENOENT(err)) {
          toolUseContext.readFileState.delete(filePath)
        }
        return null
      }
    }),
  )
  return results.filter((result) => result != null) as Attachment[]
}
