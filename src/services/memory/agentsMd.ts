/**
 * 文件按以下顺序加载：
 *
 * 1. 托管 memory（如 /etc/zy-code/AGENTS.md）：面向所有用户的全局指令
 * 2. 用户 memory（~/.zy/AGENTS.md）：面向所有项目的私有全局指令
 * 3. 项目 memory（项目根目录中的 AGENTS.md、.zy/AGENTS.md 和 .zy/rules/*.md）：随代码提交的指令
 * 4. 本地 memory（项目根目录中的 AGENTS.local.md）：项目专属的私有指令
 *
 * 文件按优先级从低到高加载，即越晚加载的文件优先级越高，模型会给予更多关注。
 *
 * 文件发现规则：
 * - 从用户主目录加载用户 memory
 * - 从当前目录向上遍历至根目录，发现项目与本地文件
 * - 越靠近当前目录的文件优先级越高（加载得更晚）
 * - 在每层目录检查 AGENTS.md、.zy/AGENTS.md 及 .zy/rules/ 下所有 .md 文件，作为项目 memory
 *
 * Memory @include 指令：
 * - Memory 文件可使用 @ 表示法包含其他文件
 * - 语法：@path、@./relative/path、@~/home/path 或 @/absolute/path
 * - 无前缀的 @path 按相对路径处理，与 @./path 相同
 * - 仅在叶子文本节点中生效，不处理代码块或代码字符串
 * - 被包含文件会作为独立条目添加在包含方之前
 * - 通过记录已处理文件避免循环引用
 * - 不存在的文件会被静默忽略
 */

import { feature } from 'bun:bundle'
import { basename, dirname, extname, isAbsolute, join, parse, relative, sep } from 'node:path'
import ignore from 'ignore'
import memoize from 'lodash-es/memoize.js'
import { Lexer } from 'marked'
import picomatch from 'picomatch'
import { logEvent } from 'src/services/analytics/index.js'
import type { MemoryType } from 'src/services/memory/types.js'
import { getAdditionalDirectoriesForAgentsMd } from 'src/bootstrap/runtime/runtimeContext.js'
import { getOriginalCwd } from 'src/bootstrap/runtime/runtimeContext.js'
import { truncateEntrypointContent } from '../../memdir/memdir.js'
import { getAutoMemEntrypoint, isAutoMemoryEnabled } from '../../memdir/paths.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../analytics/growthbook.js'
import {
  getCurrentProjectConfig,
  getManagedZyRulesDir,
  getMemoryPath,
  getUserZyRulesDir,
} from '../config/config.js'
import { logForDebugging } from '../infra/debug.js'
import { logForDiagnosticsNoPII } from '../telemetry/diagLogs.js'
import { getZyConfigHomeDir, isEnvTruthy } from '../infra/envUtils.js'
import { getErrnoCode } from '../../utils/errors.js'
import { normalizePathForComparison } from '../infra/file.js'
import { cacheKeys, type FileStateCache } from '../file-persistence/fileStateCache.js'
import { parseFrontmatter, splitPathInFrontmatter } from '../markdown/frontmatterParser.js'
import { getFsImplementation, safeResolvePath } from '../infra/fsOperations.js'
import { findCanonicalGitRoot, findGitRoot } from '../infra/git.js'
import {
  executeInstructionsLoadedHooks,
  hasInstructionsLoadedHook,
  type InstructionsLoadReason,
  type InstructionsMemoryType,
} from '../hooks.js'
import { expandPath } from '../../utils/path.js'
import { pathInWorkingPath } from '../permissions/internalPaths.js'
import { isSettingSourceEnabled } from '../settings/constants.js'
import { getInitialSettings } from '../settings/settings.js'

/* eslint-disable @typescript-eslint/no-require-imports */
const teamMemPaths = feature('TEAMMEM')
  ? (require('../../memdir/teamMemPaths.js') as typeof import('../../memdir/teamMemPaths.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

let hasLoggedInitialLoad = false

const MEMORY_INSTRUCTION_PROMPT =
  'Codebase and user instructions are shown below. Be sure to adhere to these instructions. IMPORTANT: These instructions OVERRIDE any default behavior and you MUST follow them exactly as written.'
// memory 文件建议的最大字符数。
export const MAX_MEMORY_CHARACTER_COUNT = 40000

// @include 指令允许的文件扩展名，避免将图片、PDF 等二进制文件载入 memory。
const TEXT_FILE_EXTENSIONS = new Set([
  // Markdown 与文本。
  '.md',
  '.txt',
  '.text',
  // 数据格式。
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.xml',
  '.csv',
  // Web。
  '.html',
  '.htm',
  '.css',
  '.scss',
  '.sass',
  '.less',
  // JavaScript/TypeScript。
  '.js',
  '.ts',
  '.tsx',
  '.jsx',
  '.mjs',
  '.cjs',
  '.mts',
  '.cts',
  // Python。
  '.py',
  '.pyi',
  '.pyw',
  // Ruby。
  '.rb',
  '.erb',
  '.rake',
  // Go。
  '.go',
  // Rust。
  '.rs',
  // Java/Kotlin/Scala。
  '.java',
  '.kt',
  '.kts',
  '.scala',
  // C/C++。
  '.c',
  '.cpp',
  '.cc',
  '.cxx',
  '.h',
  '.hpp',
  '.hxx',
  // C#。
  '.cs',
  // Swift。
  '.swift',
  // Shell。
  '.sh',
  '.bash',
  '.zsh',
  '.fish',
  '.ps1',
  '.bat',
  '.cmd',
  // 配置文件。
  '.env',
  '.ini',
  '.cfg',
  '.conf',
  '.config',
  '.properties',
  // 数据库。
  '.sql',
  '.graphql',
  '.gql',
  // 协议。
  '.proto',
  // 前端框架。
  '.vue',
  '.svelte',
  '.astro',
  // 模板。
  '.ejs',
  '.hbs',
  '.pug',
  '.jade',
  // 其他语言。
  '.php',
  '.pl',
  '.pm',
  '.lua',
  '.r',
  '.R',
  '.dart',
  '.ex',
  '.exs',
  '.erl',
  '.hrl',
  '.clj',
  '.cljs',
  '.cljc',
  '.edn',
  '.hs',
  '.lhs',
  '.elm',
  '.ml',
  '.mli',
  '.f',
  '.f90',
  '.f95',
  '.for',
  // 构建文件。
  '.cmake',
  '.make',
  '.makefile',
  '.gradle',
  '.sbt',
  // 文档。
  '.rst',
  '.adoc',
  '.asciidoc',
  '.org',
  '.tex',
  '.latex',
  // lock 文件，通常为文本格式。
  '.lock',
  // 其他。
  '.log',
  '.diff',
  '.patch',
])

export type MemoryFileInfo = {
  path: string
  type: MemoryType
  content: string
  parent?: string // Path of the file that included this one
  globs?: string[] // Glob patterns for file paths this rule applies to
  // auto-injection 转换 `content`（移除 HTML 注释、移除 frontmatter、截断 MEMORY.md）
  // 后与磁盘字节不再一致时为 true。设置后，`rawContent` 保存未经修改的磁盘字节，
  // 供调用方缓存 `isPartialView` readFileState 条目；缓存可用于去重和变更检测，
  // 但 Edit/Write 在继续前仍要求显式执行 Read。
  contentDiffersFromDisk?: boolean
  rawContent?: string
}

function pathInOriginalCwd(path: string): boolean {
  return pathInWorkingPath(path, getOriginalCwd())
}

/**
 * 解析原始内容，提取正文及 frontmatter 中的 glob 模式。
 * @param rawContent 包含 frontmatter 的原始文件内容
 * @returns 包含 content 和 globs 的对象；无路径或为全匹配模式时 globs 为 undefined
 */
function parseFrontmatterPaths(rawContent: string): {
  content: string
  paths?: string[]
} {
  const { frontmatter, content } = parseFrontmatter(rawContent)

  if (!frontmatter.paths) {
    return { content }
  }

  const patterns = splitPathInFrontmatter(frontmatter.paths)
    .map((pattern) => {
      // 移除 /** 后缀；ignore 库会将 'path' 视为同时匹配路径本身及其中所有内容。
      return pattern.endsWith('/**') ? pattern.slice(0, -3) : pattern
    })
    .filter((p: string) => p.length > 0)

  // 若所有模式均为 **（全匹配），则视为未设置 globs（undefined），
  // 表示该文件适用于所有路径。
  if (patterns.length === 0 || patterns.every((p: string) => p === '**')) {
    return { content }
  }

  return { content, paths: patterns }
}

/**
 * 从 markdown 内容中移除块级 HTML 注释（<!-- ... -->）。
 *
 * 使用 marked lexer 仅识别块级注释，因此会保留行内代码和围栏代码块内的注释。
 * 段落中的行内 HTML 注释也保持不变；目标场景是独占一行的作者备注。
 *
 * 未闭合的注释（`<!--` 没有匹配的 `-->`）保持原样，避免拼写错误静默吞掉文件余下内容。
 */
export function stripHtmlComments(content: string): {
  content: string
  stripped: boolean
} {
  if (!content.includes('<!--')) {
    return { content, stripped: false }
  }
  // 此处使用 gfm:false 没有问题，因为 HTML 块检测属于 CommonMark 规则。
  return stripHtmlCommentsFromTokens(new Lexer({ gfm: false }).lex(content))
}

function stripHtmlCommentsFromTokens(tokens: ReturnType<Lexer['lex']>): {
  content: string
  stripped: boolean
} {
  let result = ''
  let stripped = false

  // 匹配格式正确的 HTML 注释区段。使用非贪婪匹配，使同一行的多条注释可独立匹配；
  // [\s\S] 用于跨行匹配。
  const commentSpan = /<!--[\s\S]*?-->/g

  for (const token of tokens) {
    if (token.type === 'html') {
      const trimmed = token.raw.trimStart()
      if (trimmed.startsWith('<!--') && trimmed.includes('-->')) {
        // 按 CommonMark，type-2 HTML 块在包含 `-->` 的整行结束，因此该行中
        // `-->` 后的文本也属于此 token。仅移除注释区段，保留其余内容。
        const residue = token.raw.replace(commentSpan, '')
        stripped = true
        if (residue.trim().length > 0) {
          // 存在剩余内容（如 `<!-- note --> Use bun`）时保留。
          result += residue
        }
        continue
      }
    }
    result += token.raw
  }

  return { content: result, stripped }
}

/**
 * 将 memory 文件原始内容解析为 MemoryFileInfo。纯函数，不执行 I/O。
 *
 * 提供 includeBasePath 时，在同一次 lex 中解析 @include 路径，并与已解析文件
 * 一同返回，避免 processMemoryFile 对同一内容执行第二次 lex。
 */
function parseMemoryFileContent(
  rawContent: string,
  filePath: string,
  type: MemoryType,
  includeBasePath?: string,
): { info: MemoryFileInfo | null; includePaths: string[] } {
  // 跳过非文本文件，避免将图片、PDF 等二进制数据载入 memory。
  const ext = extname(filePath).toLowerCase()
  if (ext && !TEXT_FILE_EXTENSIONS.has(ext)) {
    logForDebugging(`Skipping non-text file in @include: ${filePath}`)
    return { info: null, includePaths: [] }
  }

  const { content: withoutFrontmatter, paths } = parseFrontmatterPaths(rawContent)

  // 只执行一次 lex，让移除注释与提取 @include 共用 token。extract 要求
  // gfm:false，以免将 ~/path 解析为删除线；这不影响移除注释，因为 HTML 块属于
  // CommonMark 规则。
  const hasComment = withoutFrontmatter.includes('<!--')
  const tokens =
    hasComment || includeBasePath !== undefined
      ? new Lexer({ gfm: false }).lex(withoutFrontmatter)
      : undefined

  // 仅在确实需要移除注释时通过 token 重建。marked 会在 lex 时规范化 \r\n，
  // 因此让 CRLF 文件经过 token.raw 往返会错误改变 contentDiffersFromDisk。
  const strippedContent =
    hasComment && tokens ? stripHtmlCommentsFromTokens(tokens).content : withoutFrontmatter

  const includePaths =
    tokens && includeBasePath !== undefined
      ? extractIncludePathsFromTokens(tokens, includeBasePath)
      : []

  // 同时按行数和字节上限截断 MEMORY.md 入口文件。
  let finalContent = strippedContent
  if (type === 'AutoMem' || type === 'TeamMem') {
    finalContent = truncateEntrypointContent(strippedContent).content
  }

  // 覆盖移除 frontmatter、移除 HTML 注释和截断 MEMORY.md 的情况。
  const contentDiffersFromDisk = finalContent !== rawContent
  return {
    info: {
      path: filePath,
      type,
      content: finalContent,
      globs: paths,
      contentDiffersFromDisk,
      rawContent: contentDiffersFromDisk ? rawContent : undefined,
    },
    includePaths,
  }
}

function handleMemoryFileReadError(error: unknown, filePath: string): void {
  const code = getErrnoCode(error)
  // ENOENT 表示文件不存在，EISDIR 表示路径为目录，二者均属预期情况。
  if (code === 'ENOENT' || code === 'EISDIR') {
    return
  }
  // 权限错误（EACCES）可采取措施解决，因此记录日志。
  if (code === 'EACCES') {
    // 不记录完整文件路径，以避免 PII 和安全问题。
    logEvent('zy_agents_md_permission_error', {
      is_access_error: 1,
      has_home_dir: filePath.includes(getZyConfigHomeDir()) ? 1 : 0,
    })
  }
}

/**
 * 由 processMemoryFile → getMemoryFiles 使用，使目录遍历期间事件循环保持响应；
 * 此过程会尝试大量 readFile，其中多数返回 ENOENT。提供 includeBasePath 时，
 * 在同一次 lex 中解析 @include 路径，并与已解析文件一同返回。
 */
async function safelyReadMemoryFileAsync(
  filePath: string,
  type: MemoryType,
  includeBasePath?: string,
): Promise<{ info: MemoryFileInfo | null; includePaths: string[] }> {
  try {
    const fs = getFsImplementation()
    const rawContent = await fs.readFile(filePath, { encoding: 'utf-8' })
    return parseMemoryFileContent(rawContent, filePath, type, includeBasePath)
  } catch (error) {
    handleMemoryFileReadError(error, filePath)
    return { info: null, includePaths: [] }
  }
}

type MarkdownToken = {
  type: string
  text?: string
  href?: string
  tokens?: MarkdownToken[]
  raw?: string
  items?: MarkdownToken[]
}

// 从已 lex 的 token 中提取 @path include 引用并解析为绝对路径。跳过 HTML token，
// 从而忽略块注释内的 @path；调用方可能传入尚未移除注释的 token。
function extractIncludePathsFromTokens(
  tokens: ReturnType<Lexer['lex']>,
  basePath: string,
): string[] {
  const absolutePaths = new Set<string>()

  // 从文本字符串提取 @path，并将解析后的路径加入 absolutePaths。
  function extractPathsFromText(textContent: string) {
    const includeRegex = /(?:^|\s)@((?:[^\s\\]|\\ )+)/g
    let match
    while ((match = includeRegex.exec(textContent)) !== null) {
      let path = match[1]
      if (!path) {
        continue
      }

      // 移除 fragment 标识符，如 #heading、#section-name。
      const hashIndex = path.indexOf('#')
      if (hashIndex !== -1) {
        path = path.substring(0, hashIndex)
      }
      if (!path) {
        continue
      }

      // 还原路径中转义的空格。
      path = path.replace(/\\ /g, ' ')

      // Accept @path, @./path, @~/path, or @/path
      if (path) {
        const isValidPath =
          path.startsWith('./') ||
          path.startsWith('~/') ||
          (path.startsWith('/') && path !== '/') ||
          (!path.startsWith('@') && !path.match(/^[#%^&*()]+/) && path.match(/^[a-zA-Z0-9._-]/))

        if (isValidPath) {
          const resolvedPath = expandPath(path, dirname(basePath))
          absolutePaths.add(resolvedPath)
        }
      }
    }
  }

  // 递归处理元素以查找文本节点。
  function processElements(elements: MarkdownToken[]) {
    for (const element of elements) {
      if (element.type === 'code' || element.type === 'codespan') {
        continue
      }

      // 对包含注释的 HTML token，移除注释区段并检查剩余内容中的 @path，
      // 如 `<!-- note --> @./file.md`。其他 HTML token（非注释标签）完全跳过。
      if (element.type === 'html') {
        const raw = element.raw || ''
        const trimmed = raw.trimStart()
        if (trimmed.startsWith('<!--') && trimmed.includes('-->')) {
          const commentSpan = /<!--[\s\S]*?-->/g
          const residue = raw.replace(commentSpan, '')
          if (residue.trim().length > 0) {
            extractPathsFromText(residue)
          }
        }
        continue
      }

      // 处理文本节点。
      if (element.type === 'text') {
        extractPathsFromText(element.text || '')
      }

      // 递归处理子 token。
      if (element.tokens) {
        processElements(element.tokens)
      }

      // 特殊处理列表结构。
      if (element.items) {
        processElements(element.items)
      }
    }
  }

  processElements(tokens as MarkdownToken[])
  return [...absolutePaths]
}

const MAX_INCLUDE_DEPTH = 5

/**
 * 检查 AGENTS.md 文件路径是否被 agentsMdExcludes 设置排除。
 * 仅适用于 User、Project 和 Local memory；Managed、AutoMem、TeamMem 永不排除。
 *
 * 同时匹配原始路径和 realpath 解析后的路径，以处理符号链接，
 * 如 macOS 上的 /tmp -> /private/tmp。
 */
function isAgentsMdExcluded(filePath: string, type: MemoryType): boolean {
  if (type !== 'User' && type !== 'Project' && type !== 'Local') {
    return false
  }

  const patterns = getInitialSettings().agentsMdExcludes
  if (!patterns || patterns.length === 0) {
    return false
  }

  const matchOpts = { dot: true }
  const normalizedPath = filePath.replaceAll('\\', '/')

  // 构造扩展模式列表，加入绝对模式经 realpath 解析后的版本，以处理 macOS 上
  // /tmp -> /private/tmp 等符号链接。用户在 exclude 中写入
  // "/tmp/project/AGENTS.md"，系统却将 CWD 解析为 "/private/tmp/project/..."；
  // 同时解析模式后，两侧即可匹配。
  const expandedPatterns = resolveExcludePatterns(patterns).filter((p) => p.length > 0)
  if (expandedPatterns.length === 0) {
    return false
  }

  return picomatch.isMatch(normalizedPath, expandedPatterns, matchOpts)
}

/**
 * 通过解析绝对路径前缀中的符号链接来扩展排除模式。对每个以 / 开头的绝对模式，
 * 尝试用 realpathSync 解析最长的现有目录前缀并添加解析版本；包含 * 的 glob 模式
 * 则解析其静态前缀。
 */
function resolveExcludePatterns(patterns: string[]): string[] {
  const fs = getFsImplementation()
  const expanded: string[] = patterns.map((p) => p.replaceAll('\\', '/'))

  for (const normalized of expanded) {
    // 仅解析绝对模式；"**/*.md" 等纯 glob 模式没有可解析的文件系统前缀。
    if (!normalized.startsWith('/')) {
      continue
    }

    // 查找首个 glob 字符前的静态前缀。
    const globStart = normalized.search(/[*?{[]/)
    const staticPrefix = globStart === -1 ? normalized : normalized.slice(0, globStart)
    const dirToResolve = dirname(staticPrefix)

    try {
      // 同步 I/O：从同步上下文调用（isAgentsMdExcluded → processMemoryFile → getMemoryFiles）。
      const resolvedDir = fs.realpathSync(dirToResolve).replaceAll('\\', '/')
      if (resolvedDir !== dirToResolve) {
        const resolvedPattern = resolvedDir + normalized.slice(dirToResolve.length)
        expanded.push(resolvedPattern)
      }
    } catch {
      // 目录不存在，跳过此模式的解析。
    }
  }

  return expanded
}

/**
 * 递归处理 memory 文件及其全部 @include 引用，返回 MemoryFileInfo 数组，
 * 被包含文件在前，主文件在后。
 */
export async function processMemoryFile(
  filePath: string,
  type: MemoryType,
  processedPaths: Set<string>,
  includeExternal: boolean,
  depth: number = 0,
  parent?: string,
): Promise<MemoryFileInfo[]> {
  // 已处理或超过最大深度时跳过。比较前规范化路径，以处理 Windows 驱动器盘符
  // 大小写差异，如 C:\Users 与 c:\Users。
  const normalizedPath = normalizePathForComparison(filePath)
  if (processedPaths.has(normalizedPath) || depth >= MAX_INCLUDE_DEPTH) {
    return []
  }

  // 路径被 agentsMdExcludes 设置排除时跳过。
  if (isAgentsMdExcluded(filePath, type)) {
    return []
  }

  // 提前解析符号链接路径，供 @import 解析使用。
  const { resolvedPath, isSymlink } = safeResolvePath(getFsImplementation(), filePath)

  processedPaths.add(normalizedPath)
  if (isSymlink) {
    processedPaths.add(normalizePathForComparison(resolvedPath))
  }

  const { info: memoryFile, includePaths: resolvedIncludePaths } = await safelyReadMemoryFileAsync(
    filePath,
    type,
    resolvedPath,
  )
  if (!memoryFile?.content.trim()) {
    return []
  }

  // 添加父级信息。
  if (parent) {
    memoryFile.parent = parent
  }

  const result: MemoryFileInfo[] = []

  // 先添加主文件，确保父级先于子级。
  result.push(memoryFile)

  for (const resolvedIncludePath of resolvedIncludePaths) {
    const isExternal = !pathInOriginalCwd(resolvedIncludePath)
    if (isExternal && !includeExternal) {
      continue
    }

    // 以当前文件为父级递归处理被包含文件。
    const includedFiles = await processMemoryFile(
      resolvedIncludePath,
      type,
      processedPaths,
      includeExternal,
      depth + 1,
      filePath, // Pass current file as parent
    )
    result.push(...includedFiles)
  }

  return result
}

/**
 * 处理 .zy/rules/ 目录及其子目录中的所有 .md 文件。
 * @param rulesDir rules 目录路径
 * @param type memory 文件类型（User、Project、Local）
 * @param processedPaths 已处理文件路径集合
 * @param includeExternal 是否包含外部文件
 * @param conditionalRule 为 true 时仅包含带 frontmatter paths 的文件；为 false 时仅包含不带该字段的文件
 * @param visitedDirs 已访问目录的真实路径集合，用于检测循环
 * @returns MemoryFileInfo 对象数组
 */
export async function processMdRules({
  rulesDir,
  type,
  processedPaths,
  includeExternal,
  conditionalRule,
  visitedDirs = new Set(),
}: {
  rulesDir: string
  type: MemoryType
  processedPaths: Set<string>
  includeExternal: boolean
  conditionalRule: boolean
  visitedDirs?: Set<string>
}): Promise<MemoryFileInfo[]> {
  if (visitedDirs.has(rulesDir)) {
    return []
  }

  try {
    const fs = getFsImplementation()

    const { resolvedPath: resolvedRulesDir, isSymlink } = safeResolvePath(fs, rulesDir)

    visitedDirs.add(rulesDir)
    if (isSymlink) {
      visitedDirs.add(resolvedRulesDir)
    }

    const result: MemoryFileInfo[] = []
    let entries: import('fs').Dirent[]
    try {
      entries = await fs.readdir(resolvedRulesDir)
    } catch (e: unknown) {
      const code = getErrnoCode(e)
      if (code === 'ENOENT' || code === 'EACCES' || code === 'ENOTDIR') {
        return []
      }
      throw e
    }

    for (const entry of entries) {
      const entryPath = join(rulesDir, entry.name)
      const { resolvedPath: resolvedEntryPath, isSymlink } = safeResolvePath(fs, entryPath)

      // 非符号链接使用 Dirent 方法，避免额外 stat；符号链接则需 stat 判断目标类型。
      const stats = isSymlink ? await fs.stat(resolvedEntryPath) : null
      const isDirectory = stats ? stats.isDirectory() : entry.isDirectory()
      const isFile = stats ? stats.isFile() : entry.isFile()

      if (isDirectory) {
        result.push(
          ...(await processMdRules({
            rulesDir: resolvedEntryPath,
            type,
            processedPaths,
            includeExternal,
            conditionalRule,
            visitedDirs,
          })),
        )
      } else if (isFile && entry.name.endsWith('.md')) {
        const files = await processMemoryFile(
          resolvedEntryPath,
          type,
          processedPaths,
          includeExternal,
        )
        result.push(...files.filter((f) => (conditionalRule ? f.globs : !f.globs)))
      }
    }

    return result
  } catch (error) {
    if (error instanceof Error && error.message.includes('EACCES')) {
      logEvent('zy_Zy_rules_md_permission_error', {
        is_access_error: 1,
        has_home_dir: rulesDir.includes(getZyConfigHomeDir()) ? 1 : 0,
      })
    }
    return []
  }
}

export const getMemoryFiles = memoize(
  async (forceIncludeExternal: boolean = false): Promise<MemoryFileInfo[]> => {
    const startTime = Date.now()
    logForDiagnosticsNoPII('info', 'memory_files_started')

    const result: MemoryFileInfo[] = []
    const processedPaths = new Set<string>()
    const config = getCurrentProjectConfig()
    const includeExternal =
      forceIncludeExternal || config.hasAgentsMdExternalIncludesApproved || false

    // 先处理 Managed 文件；作为策略设置始终加载。
    const managedAgentsMd = getMemoryPath('Managed')
    result.push(
      ...(await processMemoryFile(managedAgentsMd, 'Managed', processedPaths, includeExternal)),
    )
    // 处理 Managed .zy/rules/*.md 文件。
    const managedZyRulesDir = getManagedZyRulesDir()
    result.push(
      ...(await processMdRules({
        rulesDir: managedZyRulesDir,
        type: 'Managed',
        processedPaths,
        includeExternal,
        conditionalRule: false,
      })),
    )

    // 仅在启用 userSettings 时处理 User 文件。
    if (isSettingSourceEnabled('userSettings')) {
      const userAgentsMd = getMemoryPath('User')
      result.push(
        ...(await processMemoryFile(
          userAgentsMd,
          'User',
          processedPaths,
          true, // User memory can always include external files
        )),
      )
      // 处理 User ~/.zy/rules/*.md 文件。
      const userZyRulesDir = getUserZyRulesDir()
      result.push(
        ...(await processMdRules({
          rulesDir: userZyRulesDir,
          type: 'User',
          processedPaths,
          includeExternal: true,
          conditionalRule: false,
        })),
      )
    }

    // 随后处理 Project 和 Local 文件。
    const dirs: string[] = []
    const originalCwd = getOriginalCwd()
    let currentDir = originalCwd

    while (currentDir !== parse(currentDir).root) {
      dirs.push(currentDir)
      currentDir = dirname(currentDir)
    }

    // 从嵌套在主仓库内的 git worktree（如 `zy -w` 创建的
    // .zy/worktrees/<name>/）运行时，向上遍历会同时经过 worktree 根目录和主仓库
    // 根目录。两者都有 AGENTS.md、.zy/rules/*.md 等已提交文件，会重复加载内容。
    // 因此跳过 worktree 上方但仍位于主仓库内目录的 Project 类型文件；worktree
    // 已有自己的 checkout。AGENTS.local.md 被 gitignore，仅存在于主仓库，仍需加载。
    // See: https://github.com/anthropics/zy-code/issues/29599
    const gitRoot = findGitRoot(originalCwd)
    const canonicalRoot = findCanonicalGitRoot(originalCwd)
    const isNestedWorktree =
      gitRoot !== null &&
      canonicalRoot !== null &&
      normalizePathForComparison(gitRoot) !== normalizePathForComparison(canonicalRoot) &&
      pathInWorkingPath(gitRoot, canonicalRoot)

    // 从根目录向下处理至 CWD。
    for (const dir of dirs.reverse()) {
      // 嵌套 worktree 中跳过主仓库工作树里的已提交文件，即 canonicalRoot 内、
      // worktree 外的目录。
      const skipProject =
        isNestedWorktree &&
        pathInWorkingPath(dir, canonicalRoot) &&
        !pathInWorkingPath(dir, gitRoot)

      // 仅在启用 projectSettings 时尝试读取 Project AGENTS.md。
      if (isSettingSourceEnabled('projectSettings') && !skipProject) {
        const projectPath = join(dir, 'AGENTS.md')
        result.push(
          ...(await processMemoryFile(projectPath, 'Project', processedPaths, includeExternal)),
        )

        // 尝试读取 Project .zy/AGENTS.md。
        const dotZyPath = join(dir, '.zy', 'AGENTS.md')
        result.push(
          ...(await processMemoryFile(dotZyPath, 'Project', processedPaths, includeExternal)),
        )

        // 尝试读取 Project .zy/rules/*.md 文件。
        const rulesDir = join(dir, '.zy', 'rules')
        result.push(
          ...(await processMdRules({
            rulesDir,
            type: 'Project',
            processedPaths,
            includeExternal,
            conditionalRule: false,
          })),
        )
      }

      // 仅在启用 localSettings 时尝试读取 Local AGENTS.local.md。
      if (isSettingSourceEnabled('localSettings')) {
        const localPath = join(dir, 'AGENTS.local.md')
        result.push(
          ...(await processMemoryFile(localPath, 'Local', processedPaths, includeExternal)),
        )
      }
    }

    // 环境变量启用时处理额外目录（--add-dir）中的 AGENTS.md。该行为由
    // ZY_CODE_ADDITIONAL_DIRECTORIES_ZY_MD 控制，默认关闭。此处不检查
    // isSettingSourceEnabled('projectSettings')，因为 --add-dir 是显式用户操作，
    // 且 SDK 未指定 settingSources 时默认为 []。
    if (isEnvTruthy(process.env.ZY_CODE_ADDITIONAL_DIRECTORIES_ZY_MD)) {
      const additionalDirs = getAdditionalDirectoriesForAgentsMd()
      for (const dir of additionalDirs) {
        // 尝试读取额外目录中的 AGENTS.md。
        const projectPath = join(dir, 'AGENTS.md')
        result.push(
          ...(await processMemoryFile(projectPath, 'Project', processedPaths, includeExternal)),
        )

        // 尝试读取额外目录中的 .zy/AGENTS.md。
        const dotZyPath = join(dir, '.zy', 'AGENTS.md')
        result.push(
          ...(await processMemoryFile(dotZyPath, 'Project', processedPaths, includeExternal)),
        )

        // 尝试读取额外目录中的 .zy/rules/*.md 文件。
        const rulesDir = join(dir, '.zy', 'rules')
        result.push(
          ...(await processMdRules({
            rulesDir,
            type: 'Project',
            processedPaths,
            includeExternal,
            conditionalRule: false,
          })),
        )
      }
    }

    // Memdir 入口（memory.md）：仅在功能开启且文件存在时处理。
    if (isAutoMemoryEnabled()) {
      const { info: memdirEntry } = await safelyReadMemoryFileAsync(
        getAutoMemEntrypoint(),
        'AutoMem',
      )
      if (memdirEntry) {
        const normalizedPath = normalizePathForComparison(memdirEntry.path)
        if (!processedPaths.has(normalizedPath)) {
          processedPaths.add(normalizedPath)
          result.push(memdirEntry)
        }
      }
    }

    // Team memory 入口：仅在功能开启且文件存在时处理。
    if (feature('TEAMMEM') && teamMemPaths!.isTeamMemoryEnabled()) {
      const { info: teamMemEntry } = await safelyReadMemoryFileAsync(
        teamMemPaths!.getTeamMemEntrypoint(),
        'TeamMem',
      )
      if (teamMemEntry) {
        const normalizedPath = normalizePathForComparison(teamMemEntry.path)
        if (!processedPaths.has(normalizedPath)) {
          processedPaths.add(normalizedPath)
          result.push(teamMemEntry)
        }
      }
    }

    const totalContentLength = result.reduce((sum, f) => sum + f.content.length, 0)

    logForDiagnosticsNoPII('info', 'memory_files_completed', {
      duration_ms: Date.now() - startTime,
      file_count: result.length,
      total_content_length: totalContentLength,
    })

    const typeCounts: Record<string, number> = {}
    for (const f of result) {
      typeCounts[f.type] = (typeCounts[f.type] ?? 0) + 1
    }

    if (!hasLoggedInitialLoad) {
      hasLoggedInitialLoad = true
      logEvent('zy_agents_md_initial_load', {
        file_count: result.length,
        total_content_length: totalContentLength,
        user_count: typeCounts.User ?? 0,
        project_count: typeCounts.Project ?? 0,
        local_count: typeCounts.Local ?? 0,
        managed_count: typeCounts.Managed ?? 0,
        automem_count: typeCounts.AutoMem ?? 0,
        ...(feature('TEAMMEM') ? { teammem_count: typeCounts.TeamMem ?? 0 } : {}),
        duration_ms: Date.now() - startTime,
      })
    }

    // 为每个已加载的指令文件触发 InstructionsLoaded hook；fire-and-forget，
    // 仅用于审计和可观测性。有意排除 AutoMem/TeamMem，因为它们属于另一套 memory
    // 系统，不是 AGENTS.md/rules 意义上的“instructions”。以 !forceIncludeExternal
    // 为条件：forceIncludeExternal=true 仅供 getExternalAgentsMdIncludes() 做审批
    // 检查，不用于构建上下文；在那里触发会导致启动时重复。每次
    // !forceIncludeExternal 缓存未命中都会消费 one-shot flag，不受
    // hasInstructionsLoadedHook 控制，从而即使未配置 hook 也能释放 flag；否则会话
    // 中途注册 hook 后直接 .cache.clear()，会错误地以陈旧状态触发。
    // 'session_start' reason.
    if (!forceIncludeExternal) {
      const eagerLoadReason = consumeNextEagerLoadReason()
      if (eagerLoadReason !== undefined && hasInstructionsLoadedHook()) {
        for (const file of result) {
          if (!isInstructionsMemoryType(file.type)) {
            continue
          }
          const loadReason = file.parent ? 'include' : eagerLoadReason
          void executeInstructionsLoadedHooks(file.path, file.type, loadReason, {
            globs: file.globs,
            parentFilePath: file.parent,
          })
        }
      }
    }

    return result
  },
)

function isInstructionsMemoryType(type: MemoryType): type is InstructionsMemoryType {
  return type === 'User' || type === 'Project' || type === 'Local' || type === 'Managed'
}

// 下次主动执行 getMemoryFiles() 时，顶层（非 include）文件要报告的加载原因。
// compact 清除缓存时由 resetGetMemoryFilesCache 设为 'compact'，使
// InstructionsLoaded hook 正确报告重新加载，而非误报为 'session_start'。
// 该值为 one-shot，读取后重置为 'session_start'。
let nextEagerLoadReason: InstructionsLoadReason = 'session_start'

// 下次缓存未命中时是否应触发 InstructionsLoaded hook。初始为 true，供
// session_start 使用，触发后消费，仅由 resetGetMemoryFilesCache() 重新启用。
// 只需为正确性使缓存失效的调用方（如 worktree 进入/退出、设置同步、/memory
// 对话框）应改用 clearMemoryFileCaches()，避免错误触发 hook。
let shouldFireHook = true

function consumeNextEagerLoadReason(): InstructionsLoadReason | undefined {
  if (!shouldFireHook) {
    return undefined
  }
  shouldFireHook = false
  const reason = nextEagerLoadReason
  nextEagerLoadReason = 'session_start'
  return reason
}

/**
 * 清除 getMemoryFiles memoize 缓存，但不触发 InstructionsLoaded hook。
 *
 * 用于仅为正确性而使缓存失效的场景，如 worktree 进入/退出、设置同步、/memory
 * 对话框。对于实际将指令重新载入上下文的事件（如 compact），改用
 * resetGetMemoryFilesCache()。
 */
export function clearMemoryFileCaches(): void {
  // 使用 ?.cache，因为测试会 spyOn 此函数并替换 memoize wrapper。
  getMemoryFiles.cache?.clear?.()
}

export function resetGetMemoryFilesCache(reason: InstructionsLoadReason = 'session_start'): void {
  nextEagerLoadReason = reason
  shouldFireHook = true
  clearMemoryFileCaches()
}

export function getLargeMemoryFiles(files: MemoryFileInfo[]): MemoryFileInfo[] {
  return files.filter((f) => f.content.length > MAX_MEMORY_CHARACTER_COUNT)
}

/**
 * zy_moth_copse 开启时，findRelevantMemories prefetch 会通过附件提供 memory 文件，
 * 因此不再将 MEMORY.md 索引注入 system prompt。关注“上下文中实际有哪些内容”的
 * 调用点（context builder、/context 可视化）应通过此函数过滤。
 */
export function filterInjectedMemoryFiles(files: MemoryFileInfo[]): MemoryFileInfo[] {
  const skipMemoryIndex = getFeatureValue_CACHED_MAY_BE_STALE('zy_moth_copse', false)
  if (!skipMemoryIndex) {
    return files
  }
  return files.filter((f) => f.type !== 'AutoMem' && f.type !== 'TeamMem')
}

export const getAgentsMds = (
  memoryFiles: MemoryFileInfo[],
  filter?: (type: MemoryType) => boolean,
): string => {
  const memories: string[] = []
  const skipProjectLevel = getFeatureValue_CACHED_MAY_BE_STALE('zy_paper_halyard', false)

  for (const file of memoryFiles) {
    if (filter && !filter(file.type)) {
      continue
    }
    if (skipProjectLevel && (file.type === 'Project' || file.type === 'Local')) {
      continue
    }
    if (file.content) {
      const description =
        file.type === 'Project'
          ? ' (project instructions, checked into the codebase)'
          : file.type === 'Local'
            ? " (user's private project instructions, not checked in)"
            : feature('TEAMMEM') && file.type === 'TeamMem'
              ? ' (shared team memory, synced across the organization)'
              : file.type === 'AutoMem'
                ? " (user's auto-memory, persists across conversations)"
                : " (user's private global instructions for all projects)"

      const content = file.content.trim()
      if (feature('TEAMMEM') && file.type === 'TeamMem') {
        memories.push(
          `Contents of ${file.path}${description}:\n\n<team-memory-content source="shared">\n${content}\n</team-memory-content>`,
        )
      } else {
        memories.push(`Contents of ${file.path}${description}:\n\n${content}`)
      }
    }
  }

  if (memories.length === 0) {
    return ''
  }

  return `${MEMORY_INSTRUCTION_PROMPT}\n\n${memories.join('\n\n')}`
}

/**
 * 获取匹配目标路径的 managed 与 user 条件规则。这是嵌套 memory 加载的第一阶段。
 *
 * @param targetPath 要与 glob 模式匹配的目标文件路径
 * @param processedPaths 已处理文件路径集合，会被修改
 * @returns 匹配条件规则的 MemoryFileInfo 对象数组
 */
export async function getManagedAndUserConditionalRules(
  targetPath: string,
  processedPaths: Set<string>,
): Promise<MemoryFileInfo[]> {
  const result: MemoryFileInfo[] = []

  // 处理 Managed 条件 .zy/rules/*.md 文件。
  const managedZyRulesDir = getManagedZyRulesDir()
  result.push(
    ...(await processConditionedMdRules(
      targetPath,
      managedZyRulesDir,
      'Managed',
      processedPaths,
      false,
    )),
  )

  if (isSettingSourceEnabled('userSettings')) {
    // 处理 User 条件 .zy/rules/*.md 文件。
    const userZyRulesDir = getUserZyRulesDir()
    result.push(
      ...(await processConditionedMdRules(
        targetPath,
        userZyRulesDir,
        'User',
        processedPaths,
        true,
      )),
    )
  }

  return result
}

/**
 * 获取单个嵌套目录（CWD 与目标之间）的 memory 文件，并加载该目录的 AGENTS.md、
 * 无条件规则和条件规则。
 *
 * @param dir 要处理的目录
 * @param targetPath 用于匹配条件规则的目标文件路径
 * @param processedPaths 已处理文件路径集合，会被修改
 * @returns MemoryFileInfo 对象数组
 */
export async function getMemoryFilesForNestedDirectory(
  dir: string,
  targetPath: string,
  processedPaths: Set<string>,
): Promise<MemoryFileInfo[]> {
  const result: MemoryFileInfo[] = []

  // 处理项目 memory 文件（AGENTS.md 和 .zy/AGENTS.md）。
  if (isSettingSourceEnabled('projectSettings')) {
    const projectPath = join(dir, 'AGENTS.md')
    result.push(...(await processMemoryFile(projectPath, 'Project', processedPaths, false)))
    const dotZyPath = join(dir, '.zy', 'AGENTS.md')
    result.push(...(await processMemoryFile(dotZyPath, 'Project', processedPaths, false)))
  }

  // 处理本地 memory 文件（AGENTS.local.md）。
  if (isSettingSourceEnabled('localSettings')) {
    const localPath = join(dir, 'AGENTS.local.md')
    result.push(...(await processMemoryFile(localPath, 'Local', processedPaths, false)))
  }

  const rulesDir = join(dir, '.zy', 'rules')

  // 处理未主动加载的项目无条件 .zy/rules/*.md 文件。使用独立 processedPaths 集合，
  // 避免将条件规则文件标记为已处理。
  const unconditionalProcessedPaths = new Set(processedPaths)
  result.push(
    ...(await processMdRules({
      rulesDir,
      type: 'Project',
      processedPaths: unconditionalProcessedPaths,
      includeExternal: false,
      conditionalRule: false,
    })),
  )

  // 处理项目条件 .zy/rules/*.md 文件。
  result.push(
    ...(await processConditionedMdRules(targetPath, rulesDir, 'Project', processedPaths, false)),
  )

  // processedPaths 必须以无条件路径作为初始值，供后续目录使用。
  for (const path of unconditionalProcessedPaths) {
    processedPaths.add(path)
  }

  return result
}

/**
 * 获取 CWD 层级目录（从根目录至 CWD）的条件规则。无条件规则已主动加载，
 * 因此这里只处理条件规则。
 *
 * @param dir 要处理的目录
 * @param targetPath 用于匹配条件规则的目标文件路径
 * @param processedPaths 已处理文件路径集合，会被修改
 * @returns MemoryFileInfo 对象数组
 */
export async function getConditionalRulesForCwdLevelDirectory(
  dir: string,
  targetPath: string,
  processedPaths: Set<string>,
): Promise<MemoryFileInfo[]> {
  const rulesDir = join(dir, '.zy', 'rules')
  return processConditionedMdRules(targetPath, rulesDir, 'Project', processedPaths, false)
}

/**
 * 处理 .zy/rules/ 目录及其子目录中的所有 .md 文件，仅保留 frontmatter paths
 * 匹配目标路径的文件。
 * @param targetPath 要与 frontmatter glob 模式匹配的文件路径
 * @param rulesDir rules 目录路径
 * @param type memory 文件类型（User、Project、Local）
 * @param processedPaths 已处理文件路径集合
 * @param includeExternal 是否包含外部文件
 * @returns 匹配目标路径的 MemoryFileInfo 对象数组
 */
export async function processConditionedMdRules(
  targetPath: string,
  rulesDir: string,
  type: MemoryType,
  processedPaths: Set<string>,
  includeExternal: boolean,
): Promise<MemoryFileInfo[]> {
  const conditionedRuleMdFiles = await processMdRules({
    rulesDir,
    type,
    processedPaths,
    includeExternal,
    conditionalRule: true,
  })

  // 仅保留 glob 模式匹配 targetPath 的文件。
  return conditionedRuleMdFiles.filter((file) => {
    if (!file.globs || file.globs.length === 0) {
      return false
    }

    // Project 规则的 glob 模式相对于包含 .zy 的目录；Managed/User 规则则相对于
    // 原始 CWD。
    const baseDir =
      type === 'Project'
        ? dirname(dirname(rulesDir)) // Parent of .zy
        : getOriginalCwd() // Project root for managed/user rules

    const relativePath = isAbsolute(targetPath) ? relative(baseDir, targetPath) : targetPath
    // ignore() 会对空字符串、逃逸 base 的路径（../）和绝对路径抛错；Windows 跨盘
    // relative() 会返回绝对路径。baseDir 外的文件本就无法匹配相对 baseDir 的 glob。
    if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
      return false
    }
    return ignore().add(file.globs).ignores(relativePath)
  })
}

export type ExternalAgentsMdInclude = {
  path: string
  parent: string
}

export function getExternalAgentsMdIncludes(files: MemoryFileInfo[]): ExternalAgentsMdInclude[] {
  const externals: ExternalAgentsMdInclude[] = []
  for (const file of files) {
    if (file.type !== 'User' && file.parent && !pathInOriginalCwd(file.path)) {
      externals.push({ path: file.path, parent: file.parent })
    }
  }
  return externals
}

export function hasExternalAgentsMdIncludes(files: MemoryFileInfo[]): boolean {
  return getExternalAgentsMdIncludes(files).length > 0
}

export async function shouldShowAgentsMdExternalIncludesWarning(): Promise<boolean> {
  const config = getCurrentProjectConfig()
  if (
    config.hasAgentsMdExternalIncludesApproved ||
    config.hasAgentsMdExternalIncludesWarningShown
  ) {
    return false
  }

  return hasExternalAgentsMdIncludes(await getMemoryFiles(true))
}

/**
 * 检查文件路径是否为 memory 文件（AGENTS.md、AGENTS.local.md 或 .zy/rules/*.md）。
 */
export function isMemoryFilePath(filePath: string): boolean {
  const name = basename(filePath)

  // AGENTS.md or AGENTS.local.md anywhere
  if (name === 'AGENTS.md' || name === 'AGENTS.local.md') {
    return true
  }

  // .zy/rules/ 目录中的 .md 文件。
  if (name.endsWith('.md') && filePath.includes(`${sep}.zy${sep}rules${sep}`)) {
    return true
  }

  return false
}

/**
 * 从标准发现流程和 readFileState 获取全部 memory 文件路径。
 * Combines:
 * - getMemoryFiles() 路径（从 CWD 向上至根目录）
 * - readFileState 中匹配 memory 模式的路径（包括子目录）
 */
export function getAllMemoryFilePaths(
  files: MemoryFileInfo[],
  readFileState: FileStateCache,
): string[] {
  const paths = new Set<string>()
  for (const file of files) {
    if (file.content.trim().length > 0) {
      paths.add(file.path)
    }
  }

  // 添加 readFileState 中的 memory 文件，包括子目录。
  for (const filePath of cacheKeys(readFileState)) {
    if (isMemoryFilePath(filePath)) {
      paths.add(filePath)
    }
  }

  return Array.from(paths)
}
