import { feature } from 'bun:bundle'
import { randomBytes } from 'crypto'
import ignore from 'ignore'
import memoize from 'lodash-es/memoize.js'
import { homedir, tmpdir } from 'os'
import { join, normalize, posix, sep } from 'path'
import { hasAutoMemPathOverride, isAutoMemPath } from 'src/memdir/paths.js'
import { isAgentMemoryPath } from 'src/tools/AgentTool/agentMemory.js'
import {
  CLAUDE_FOLDER_PERMISSION_PATTERN,
  FILE_EDIT_TOOL_NAME,
  GLOBAL_CLAUDE_FOLDER_PERMISSION_PATTERN,
} from 'src/tools/FileEditTool/constants.js'
import type { z } from 'zod/v4'
import { getOriginalCwd, getSessionId } from '../../bootstrap/state.js'
import { checkStatsigFeatureGate_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import type { AnyObject, Tool, ToolPermissionContext } from '../../Tool.js'
import { FILE_READ_TOOL_NAME } from '../../tools/FileReadTool/prompt.js'
import { getCwd } from '../cwd.js'
import { getZyConfigHomeDir } from '../envUtils.js'
import {
  getFsImplementation,
  getPathsForPermissionCheck,
} from '../fsOperations.js'
import {
  containsPathTraversal,
  expandPath,
  getDirectoryForPath,
  sanitizePath,
} from '../path.js'
import { getPlanSlug, getPlansDirectory } from '../plans.js'
import { getPlatform } from '../platform.js'
import { getProjectDir } from '../sessionStorage.js'
import { SETTING_SOURCES } from '../settings/constants.js'
import {
  getSettingsFilePathForSource,
  getSettingsRootPathForSource,
} from '../settings/settings.js'
import { containsVulnerableUncPath } from '../shell/readOnlyCommandValidation.js'
import { getToolResultsDir } from '../toolResultStorage.js'
import { windowsPathToPosixPath } from '../windowsPaths.js'
import type {
  PermissionDecision,
  PermissionResult,
} from './PermissionResult.js'
import type { PermissionRule, PermissionRuleSource } from './PermissionRule.js'
import { createReadRuleSuggestion } from './PermissionUpdate.js'
import type { PermissionUpdate } from './PermissionUpdateSchema.js'
import { getRuleByContentsForToolName } from './permissions.js'

declare const MACRO: { VERSION: string }

/**
 * 不应在 auto 模式下自动编辑的危险文件。
 * 这些文件可用于代码执行或数据泄露。
 */
export const DANGEROUS_FILES = [
  '.gitconfig',
  '.gitmodules',
  '.bashrc',
  '.bash_profile',
  '.zshrc',
  '.zprofile',
  '.profile',
  '.ripgreprc',
  '.mcp.json',
  '.zy.json',
] as const

/**
 * 不应在 auto 模式下自动编辑的危险目录。
 * 这些目录包含敏感配置或可执行文件。
 */
export const DANGEROUS_DIRECTORIES = [
  '.git',
  '.vscode',
  '.idea',
  '.zy',
] as const

/**
 * 规范化路径以进行不区分大小写的比较。
 * 这可以防止在不区分大小写的文件系统（macOS/Windows）上使用混合大小写路径
 * （如 `.cLauDe/Settings.locaL.json`）绕过安全检查。
 *
 * 无论平台如何，我们总是将路径转为小写以确保安全一致性。
 * @param path 要规范化的路径
 * @returns 小写路径，用于安全比较
 */
export function normalizeCaseForComparison(path: string): string {
  return path.toLowerCase()
}

/**
 * If filePath is inside a .zy/skills/{name}/ directory (project or global),
 * return the skill name and a session-allow pattern scoped to just that skill.
 * Used to offer a narrower "allow edits to this skill only" option in the
 * permission dialog and SDK suggestions, so iterating on one skill doesn't
 * require granting session access to all of .zy/ (settings.json, hooks/, etc.).
 */
export function getZySkillScope(
  filePath: string,
): { skillName: string; pattern: string } | null {
  const absolutePath = expandPath(filePath)
  const absolutePathLower = normalizeCaseForComparison(absolutePath)

  const bases = [
    {
      dir: expandPath(join(getOriginalCwd(), '.zy', 'skills')),
      prefix: '/.zy/skills/',
    },
    {
      dir: expandPath(join(homedir(), '.zy', 'skills')),
      prefix: '~/.zy/skills/',
    },
  ]

  for (const { dir, prefix } of bases) {
    const dirLower = normalizeCaseForComparison(dir)
    // 同时尝试两个路径分隔符（Windows 路径可能未规范化为 /）
    for (const s of [sep, '/']) {
      if (absolutePathLower.startsWith(dirLower + s.toLowerCase())) {
        // 在小写上匹配，但切片原始路径以保留技能名称的大小写
        // （下游模式匹配区分大小写）
        const rest = absolutePath.slice(dir.length + s.length)
        const slash = rest.indexOf('/')
        const bslash = sep === '\\' ? rest.indexOf('\\') : -1
        const cut =
          slash === -1
            ? bslash
            : bslash === -1
              ? slash
              : Math.min(slash, bslash)
        // 需要分隔符：文件必须在技能目录内部，而不是直接在 skills/ 下
        // （这种情况没有技能范围）
        if (cut <= 0) return null
        const skillName = rest.slice(0, cut)
        // 拒绝路径穿越和空值。使用 includes('..') 而非 === '..'
        // 以匹配步骤 1.6 的 ruleContent.includes('..') 守卫：
        // 像 'v2..beta' 这样的 skillName 会产生步骤 1.7 发出的建议，
        // 但步骤 1.6 始终拒绝（死建议，无限重新提示）。
        if (!skillName || skillName === '.' || skillName.includes('..')) {
          return null
        }
        // 拒绝 glob 元字符。skillName 被插入到 gitignore 模式中，
        // 由 matchingRuleForInput 中的 ignore().add() 消费（步骤 1.6）。
        // 字面名为 '*' 的目录（在 POSIX 上有效）会产生 '/.zy/skills/*/**'，
        // 这将匹配所有技能。返回 null 以便回退到 generateSuggestions()。
        if (/[*?[\]]/.test(skillName)) return null
        return { skillName, pattern: prefix + skillName + '/**' }
      }
    }
  }

  return null
}

// 始终使用 / 作为路径分隔符，遵循 gitignore 规范
// https://git-scm.com/docs/gitignore
const DIR_SEP = posix.sep

/**
 * 跨平台相对路径计算，返回 POSIX 风格路径。
 * 内部处理 Windows 路径转换。
 * @param from 基础路径
 * @param to 目标路径
 * @returns POSIX 风格的相对路径
 */
export function relativePath(from: string, to: string): string {
  if (getPlatform() === 'windows') {
    // 将 Windows 路径转换为 POSIX 以进行一致比较
    const posixFrom = windowsPathToPosixPath(from)
    const posixTo = windowsPathToPosixPath(to)
    return posix.relative(posixFrom, posixTo)
  }
  // 直接使用 POSIX 路径
  return posix.relative(from, to)
}

/**
 * 将路径转换为 POSIX 格式以进行模式匹配。
 * 内部处理 Windows 路径转换。
 * @param path 要转换的路径
 * @returns POSIX 风格的路径
 */
export function toPosixPath(path: string): string {
  if (getPlatform() === 'windows') {
    return windowsPathToPosixPath(path)
  }
  return path
}

function getSettingsPaths(): string[] {
  return SETTING_SOURCES.map(source =>
    getSettingsFilePathForSource(source),
  ).filter(path => path !== undefined)
}

export function isZySettingsPath(filePath: string): boolean {
  // 安全：先规范化路径结构以防止通过冗余 ./ 序列绕过安全
  // 例如 `./.zy/./settings.json` 会规避 endsWith() 检查
  const expandedPath = expandPath(filePath)

  // 进行不区分大小写的规范化比较，防止通过 .cLauDe/Settings.locaL.json
  // 等路径绕过安全检查
  const normalizedPath = normalizeCaseForComparison(expandedPath)

  // 使用平台分隔符以确保 endsWith 检查在 Unix (/) 和 Windows (\) 上都有效
  if (
    normalizedPath.endsWith(`${sep}.zy${sep}settings.json`) ||
    normalizedPath.endsWith(`${sep}.zy${sep}settings.local.json`)
  ) {
    // 即使是其他项目，也包含 .zy/settings.json
    return true
  }
  // 检查当前项目的设置文件（包括托管设置和 CLI 参数）
  // 两条路径现在都是绝对路径且已规范化，便于一致比较
  return getSettingsPaths().some(
    settingsPath => normalizeCaseForComparison(settingsPath) === normalizedPath,
  )
}

// ZY Code 尝试编辑自身配置文件时始终询问
function isZyConfigFilePath(filePath: string): boolean {
  if (isZySettingsPath(filePath)) {
    return true
  }

  // 检查文件是否在 .zy/commands 或 .zy/agents 目录内
  // 使用正确的路径段验证（而非用 includes() 进行字符串匹配）
  // pathInWorkingPath 现在处理不区分大小写的比较以防止绕过
  const commandsDir = join(getOriginalCwd(), '.zy', 'commands')
  const agentsDir = join(getOriginalCwd(), '.zy', 'agents')
  const skillsDir = join(getOriginalCwd(), '.zy', 'skills')

  return (
    pathInWorkingPath(filePath, commandsDir) ||
    pathInWorkingPath(filePath, agentsDir) ||
    pathInWorkingPath(filePath, skillsDir)
  )
}

// 检查文件是否为当前会话的 plan 文件
function isSessionPlanFile(absolutePath: string): boolean {
  // 检查路径是否为当前会话的 plan 文件（主文件或 agent 特定文件）
  // 主 plan 文件：{plansDir}/{planSlug}.md
  // Agent plan 文件：{plansDir}/{planSlug}-agent-{agentId}.md
  const expectedPrefix = join(getPlansDirectory(), getPlanSlug())
  // 安全：规范化以防止通过 .. 段进行路径穿越绕过
  const normalizedPath = normalize(absolutePath)
  return (
    normalizedPath.startsWith(expectedPrefix) && normalizedPath.endsWith('.md')
  )
}

/**
 * 返回当前会话的会话内存目录路径，带尾部路径分隔符。
 * 路径格式：{projectDir}/{sessionId}/session-memory/
 */
export function getSessionMemoryDir(): string {
  return join(getProjectDir(getCwd()), getSessionId(), 'session-memory') + sep
}

/**
 * 返回当前会话的会话内存文件路径。
 * 路径格式：{projectDir}/{sessionId}/session-memory/summary.md
 */
export function getSessionMemoryPath(): string {
  return join(getSessionMemoryDir(), 'summary.md')
}

// 检查文件是否在会话内存目录内
function isSessionMemoryPath(absolutePath: string): boolean {
  // 安全：规范化以防止通过 .. 段进行路径穿越绕过
  const normalizedPath = normalize(absolutePath)
  return normalizedPath.startsWith(getSessionMemoryDir())
}

/**
 * 检查文件是否在当前项目的目录内。
 * 路径格式：~/.zy/projects/{sanitized-cwd}/...
 */
function isProjectDirPath(absolutePath: string): boolean {
  const projectDir = getProjectDir(getCwd())
  // 安全：规范化以防止通过 .. 段进行路径穿越绕过
  const normalizedPath = normalize(absolutePath)
  return (
    normalizedPath === projectDir || normalizedPath.startsWith(projectDir + sep)
  )
}

/**
 * 检查暂存目录功能是否已启用。
 * 暂存目录是 Zy 写入临时文件的每会话目录。
 * 由 tengu_scratch Statsig 门控控制。
 */
export function isScratchpadEnabled(): boolean {
  return checkStatsigFeatureGate_CACHED_MAY_BE_STALE('tengu_scratch')
}

/**
 * 返回用户特定的 Zy 临时目录名称。
 * Unix 上：'zy-{uid}' 以防止多用户权限冲突
 * Windows 上：'zy'（tmpdir() 已经是每用户的）
 */
export function getZyTempDirName(): string {
  if (getPlatform() === 'windows') {
    return 'zy'
  }
  // 使用 UID 创建每用户目录，防止多个用户共享同一 /tmp 目录时的权限冲突
  const uid = process.getuid?.() ?? 0
  return `zy-${uid}`
}

/**
 * 返回已解析符号链接的 Zy 临时目录路径。
 * 如果设置了 TMPDIR 环境变量则使用它，否则：
 * - Unix 上：/tmp/zy-{uid}/（在 macOS 上解析为 /private/tmp/zy-{uid}/）
 * - Windows 上：{tmpdir}/zy/（例如 C:\Users\{user}\AppData\Local\Temp\zy\）
 * 这是 ZY Code 用于所有临时文件的每用户临时目录。
 *
 * 注意：我们解析符号链接以确保此路径与权限检查中使用的解析路径匹配。
 * 在 macOS 上，/tmp 是指向 /private/tmp 的符号链接，因此如果不解析，
 * /tmp/zy-{uid}/... 等路径将无法匹配 /private/tmp/zy-{uid}/...
 *
 * 已缓存：在权限检查（yoloClassifier、sandbox-adapter）中每次工具调用时调用，
 * 在 BashTool prompt 中每轮次调用。输入（ZY_CODE_TMPDIR 环境变量 + 平台）
 * 在启动时固定，系统 tmp 目录的 realpath 在会话中间不会改变。
 */
export const getZyTempDir = memoize(function getZyTempDir(): string {
  const baseTmpDir =
    process.env.ZY_CODE_TMPDIR ||
    (getPlatform() === 'windows' ? tmpdir() : '/tmp')

  // 解析基础临时目录中的符号链接（例如 macOS 上 /tmp -> /private/tmp）
  // 这确保路径与权限检查中的解析路径匹配
  const fs = getFsImplementation()
  let resolvedBaseTmpDir = baseTmpDir
  try {
    resolvedBaseTmpDir = fs.realpathSync(baseTmpDir)
  } catch {
    // 如果解析失败，使用原始路径
  }

  return join(resolvedBaseTmpDir, getZyTempDirName()) + sep
})

/**
 * 打包技能文件提取的根目录（参见 bundledSkills.ts）。
 *
 * 安全：每进程的随机 nonce 是这里的决定性防御。
 * 所有其他路径组件（uid、VERSION、技能名称、文件键）都是公开知识，
 * 因此如果没有 nonce，本地攻击者可以在共享 /tmp 上预先创建树 —
 * sticky bit 防止删除，但不防止创建 — 并且可以
 * 将中间目录符号链接（O_NOFOLLOW 仅检查最后一个组件），
 * 或者拥有父目录并在写入后交换文件内容以通过读允许列表进行 prompt 注入。
 * diskOutput.ts 从其路径中的会话 ID UUID 获得相同的属性。
 *
 * 已缓存，因此提取和权限检查在进程生命周期内对路径达成一致。
 * 按版本范围划分，因此来自其他二进制文件的过时提取不会落入允许列表。
 */
export const getBundledSkillsRoot = memoize(
  function getBundledSkillsRoot(): string {
    const nonce = randomBytes(16).toString('hex')
    return join(getZyTempDir(), 'bundled-skills', MACRO.VERSION, nonce)
  },
)

/**
 * 返回项目临时目录路径，带尾部路径分隔符。
 * 路径格式：/tmp/zy-{uid}/{sanitized-cwd}/
 */
export function getProjectTempDir(): string {
  return join(getZyTempDir(), sanitizePath(getOriginalCwd())) + sep
}

/**
 * 返回当前会话的暂存目录路径。
 * 路径格式：/tmp/zy-{uid}/{sanitized-cwd}/{sessionId}/scratchpad/
 */
export function getScratchpadDir(): string {
  return join(getProjectTempDir(), getSessionId(), 'scratchpad')
}

/**
 * 确保当前会话的暂存目录存在。
 * 如果目录不存在，以安全权限（0o700）创建。
 * 返回暂存目录的路径。
 * @throws 如果暂存功能未启用
 */
export async function ensureScratchpadDir(): Promise<string> {
  if (!isScratchpadEnabled()) {
    throw new Error('Scratchpad directory feature is not enabled')
  }

  const fs = getFsImplementation()
  const scratchpadDir = getScratchpadDir()

  // 递归创建目录，使用安全权限（仅所有者访问）
  // FsOperations.mkdir 内部处理 recursive: true，如果目录已存在则为无操作
  await fs.mkdir(scratchpadDir, { mode: 0o700 })

  return scratchpadDir
}

// 检查文件是否在暂存目录内
function isScratchpadPath(absolutePath: string): boolean {
  if (!isScratchpadEnabled()) {
    return false
  }
  const scratchpadDir = getScratchpadDir()
  // 安全：规范化路径以解析 .. 段后再进行检查
  // 这防止路径穿越绕过，例如：
  //   echo "malicious" > /tmp/zy-d+/proj/session/scratchpad/../../../etc/passwd
  // 如果不规范化，路径会通过 startsWith 检查，但实际写入的是 /etc/passwd
  const normalizedPath = normalize(absolutePath)
  return (
    normalizedPath === scratchpadDir ||
    normalizedPath.startsWith(scratchpadDir + sep)
  )
}

/**
 * 检查文件路径在没有显式权限的情况下对 auto 编辑是否危险。
 * 包括：
 * - .git 目录或 .gitconfig 文件中的文件（防止基于 git 的数据泄露和代码执行）
 * - .vscode 目录中的文件（防止 VS Code 设置操纵和潜在代码执行）
 * - .idea 目录中的文件（防止 JetBrains IDE 设置操纵）
 * - shell 配置文件（防止 shell 启动脚本操纵）
 * - UNC 路径（防止网络文件访问和 WebDAV 攻击）
 */
function isDangerousFilePathToAutoEdit(path: string): boolean {
  const absolutePath = expandPath(path)
  const pathSegments = absolutePath.split(sep)
  const fileName = pathSegments.at(-1)

  // 检查 UNC 路径（纵深防御，捕获 containsVulnerableUncPath 可能未捕获的模式）
  // 阻止所有以 \\ 或 // 开头的内容，因为这些可能是访问网络资源的 UNC 路径
  if (path.startsWith('\\\\') || path.startsWith('//')) {
    return true
  }

  // 检查路径是否在危险目录内（不区分大小写以防止绕过）
  for (let i = 0; i < pathSegments.length; i++) {
    const segment = pathSegments[i]!
    const normalizedSegment = normalizeCaseForComparison(segment)

    for (const dir of DANGEROUS_DIRECTORIES) {
      if (normalizedSegment !== normalizeCaseForComparison(dir)) {
        continue
      }

      // 特殊情况：.zy/worktrees/ 是结构性路径（ZY 存储 git worktree 的地方），
      // 而非用户创建的危险目录。当后面跟着 'worktrees' 时跳过 .zy 段。
      // worktree 内任何嵌套的 .zy 目录（后面不跟 'worktrees'）仍然被阻止。
      if (dir === '.zy') {
        const nextSegment = pathSegments[i + 1]
        if (
          nextSegment &&
          normalizeCaseForComparison(nextSegment) === 'worktrees'
        ) {
          break // 跳过此 .zy，继续检查其他段
        }
      }

      return true
    }
  }

  // 检查危险的配置文件（不区分大小写）
  if (fileName) {
    const normalizedFileName = normalizeCaseForComparison(fileName)
    if (
      (DANGEROUS_FILES as readonly string[]).some(
        dangerousFile =>
          normalizeCaseForComparison(dangerousFile) === normalizedFileName,
      )
    ) {
      return true
    }
  }

  return false
}

/**
 * 检测可能绕过安全检查的可疑 Windows 路径模式。
 * 这些模式包括：
 * - NTFS 备用数据流（例如 file.txt::$DATA 或 file.txt:stream）
 * - 8.3 短名称（例如 GIT~1、CLAUDE~1、SETTIN~1.JSON）
 * - 长路径前缀（例如 \\?\C:\...、\\.\C:\...、//?/C:/...、//./C:/...）
 * - 尾部点和空格（例如 .git.、.zy 、.bashrc...）
 * - DOS 设备名称（例如 .git.CON、settings.json.PRN、.bashrc.AUX）
 * - 三个或更多连续点（例如 .../file.txt、path/.../file、file...txt）
 *
 * 检测到这些路径时，应始终要求手动审批，以防止
 * 通过路径规范化漏洞绕过安全检查。
 *
 * ## 为什么在所有平台上检查？
 *
 * 虽然这些模式主要是 Windows 特有的，但 NTFS 文件系统可以挂载到
 * Linux 和 macOS 上（例如使用 ntfs-3g）。在这些系统上，相同的
 * 绕过技术也会生效 — 攻击者可以使用短名称或长路径前缀来绕过安全检查。
 * 因此，我们在所有平台上检查这些模式以确保全面保护。
 * （注意：ADS 冒号检查仅限 Windows/WSL，因为冒号语法仅由 Windows
 * 内核解释；在 Linux/macOS 上，NTFS ADS 通过 xattrs 访问，而非冒号语法。）
 *
 * ## 为什么选择检测而非规范化？
 *
 * 另一种方法是使用 Windows API（例如 GetLongPathNameW）规范化这些路径。
 * 但这种方法面临重大挑战：
 *
 * 1. **文件系统依赖**：短路径规范化相对于文件系统中当前存在的文件。
 *    这在写入新文件时会产生问题，因为它们尚不存在且无法规范化。
 *
 * 2. **竞态条件**：规范化与实际文件访问之间的文件系统状态可能发生变化，
 *    产生 TOCTOU（检查时-使用时）漏洞。
 *
 * 3. **复杂性**：正确的规范化需要 Windows 特定的 API，处理多种边缘情况，
 *    并处理各种路径格式（UNC、设备路径等）。
 *
 * 4. **可靠性**：模式检测更可预测，不依赖于外部系统状态。
 *
 * 如果你正在考虑为这些路径添加规范化，请先联系 AppSec
 * 讨论安全影响和实现方法。
 *
 * @param path 要检查可疑模式的路径
 * @returns 如果检测到可疑 Windows 路径模式则返回 true
 */
function hasSuspiciousWindowsPathPattern(path: string): boolean {
  // 检查 NTFS 备用数据流
  // 查找位置 2 之后的 ':' 以跳过盘符（例如 C:\）
  // 示例：file.txt::$DATA、.bashrc:hidden、settings.json:stream
  // 注意：ADS 冒号语法仅由 Windows 内核解释。在 WSL 上，
  // DrvFs 挂载将文件操作路由通过 Windows 内核，因此冒号
  // 语法仍被解释为 ADS 分隔符。在 Linux/macOS（非 WSL）上，
  // 即使挂载了 NTFS，ADS 也通过 xattrs（ntfs-3g）访问，而非冒号
  // 语法，冒号是有效的文件名字符。
  if (getPlatform() === 'windows' || getPlatform() === 'wsl') {
    const colonIndex = path.indexOf(':', 2)
    if (colonIndex !== -1) {
      return true
    }
  }

  // 检查 8.3 短名称
  // 查找 '~' 后跟数字
  // 示例：GIT~1、CLAUDE~1、SETTIN~1.JSON、BASHRC~1
  if (/~\d/.test(path)) {
    return true
  }

  // 检查长路径前缀（反斜杠和正斜杠变体）
  // 示例：\\?\C:\Users\...、\\.\C:\...、//?/C:/...、//./C:/...
  if (
    path.startsWith('\\\\?\\') ||
    path.startsWith('\\\\.\\') ||
    path.startsWith('//?/') ||
    path.startsWith('//./')
  ) {
    return true
  }

  // 检查 Windows 在路径解析时去除的尾部点和空格
  // 示例：.git.、.zy 、.bashrc...、settings.json.
  // 如果 ".git" 被阻止但使用 ".git."，则可以绕过字符串匹配
  if (/[.\s]+$/.test(path)) {
    return true
  }

  // 检查 Windows 视为特殊设备的 DOS 设备名称
  // 示例：.git.CON、settings.json.PRN、.bashrc.AUX
  // 设备名称：CON、PRN、AUX、NUL、COM1-9、LPT1-9
  if (/\.(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(path)) {
    return true
  }

  // 检查三个或更多连续点（...）用作路径组件时
  // 此模式可用于绕过安全检查或造成混淆
  // 示例：.../file.txt、path/.../file
  // 仅当点前后都有路径分隔符（/ 或 \）时才阻止
  // 这允许 Next.js 捕获所有路由 [...]name] 等合法用途
  if (/(^|\/|\\)\.{3,}(\/|\\|$)/.test(path)) {
    return true
  }

  // 检查 UNC 路径（在所有平台上进行纵深防御）
  // 示例：\\server\share、\\foo.com\file、//server/share、\\192.168.1.1\share
  // UNC 路径可以访问远程资源、泄露凭据并绕过工作目录限制
  if (containsVulnerableUncPath(path)) {
    return true
  }

  return false
}

/**
 * 检查路径对 auto 编辑（acceptEdits 模式）是否安全。
 * 返回路径不安全的原因信息，如果所有检查通过则返回 null。
 *
 * 此函数执行全面的安全检查，包括：
 * - 可疑 Windows 路径模式（NTFS 流、8.3 名称、长路径前缀等）
 * - Zy 配置文件（.zy/settings.json、.zy/commands/、.zy/agents/）
 * - MCP CLI 状态文件（由 ZY Code 内部管理）
 * - 危险文件（.bashrc、.gitconfig、.git/、.vscode/、.idea/ 等）
 *
 * 重要：此函数检查原始路径和解析的符号链接路径，
 * 以防止通过指向受保护文件的符号链接绕过。
 *
 * @param path 要检查安全性的路径
 * @returns 如果不安全则返回 safe=false 和 message，如果所有检查通过则返回 { safe: true }
 */
export function checkPathSafetyForAutoEdit(
  path: string,
  precomputedPathsToCheck?: readonly string[],
):
  | { safe: true }
  | { safe: false; message: string; classifierApprovable: boolean } {
  // Get all paths to check (original + symlink resolved paths)
  const pathsToCheck =
    precomputedPathsToCheck ?? getPathsForPermissionCheck(path)

  // 在所有路径上检查可疑 Windows 路径模式
  for (const pathToCheck of pathsToCheck) {
    if (hasSuspiciousWindowsPathPattern(pathToCheck)) {
      return {
        safe: false,
        message: `ZY requested permissions to write to ${path}, which contains a suspicious Windows path pattern that requires manual approval.`,
        classifierApprovable: false,
      }
    }
  }

  // 在所有路径上检查 Zy 配置文件
  for (const pathToCheck of pathsToCheck) {
    if (isZyConfigFilePath(pathToCheck)) {
      return {
        safe: false,
        message: `ZY requested permissions to write to ${path}, but you haven't granted it yet.`,
        classifierApprovable: true,
      }
    }
  }

  // 在所有路径上检查危险文件
  for (const pathToCheck of pathsToCheck) {
    if (isDangerousFilePathToAutoEdit(pathToCheck)) {
      return {
        safe: false,
        message: `ZY requested permissions to edit ${path} which is a sensitive file.`,
        classifierApprovable: true,
      }
    }
  }

  // 所有安全检查通过
  return { safe: true }
}

export function allWorkingDirectories(
  context: ToolPermissionContext,
): Set<string> {
  return new Set([
    getOriginalCwd(),
    ...(context.additionalWorkingDirectories as any).keys(),
  ])
}

// 工作目录在会话中稳定；缓存它们的解析形式以避免
// 在每次权限检查时重复执行 existsSync/lstatSync/realpathSync 系统调用。
// 以路径字符串为键 — getPathsForPermissionCheck 在会话内对于
// 现有目录是确定性的。
// 导出用于 test/preload.ts 缓存清除（shard-isolation）。
export const getResolvedWorkingDirPaths = memoize(getPathsForPermissionCheck)

export function pathInAllowedWorkingPath(
  path: string,
  toolPermissionContext: ToolPermissionContext,
  precomputedPathsToCheck?: readonly string[],
): boolean {
  // 检查原始路径和解析的符号链接路径
  const pathsToCheck =
    precomputedPathsToCheck ?? getPathsForPermissionCheck(path)

  // 与我们解析输入路径的方式相同地解析工作目录，以便
  // 比较是对称的。如果不这样做，解析后的输入路径
  // （例如 macOS 上的 /System/Volumes/Data/home/...）将无法匹配
  // 未解析的工作目录（/home/...），导致错误的拒绝。
  const workingPaths = Array.from(
    allWorkingDirectories(toolPermissionContext),
  ).flatMap(wp => getResolvedWorkingDirPaths(wp))

  // 所有路径必须在允许的工作路径内
  // 如果任何解析后的路径在外部，则拒绝访问
  return pathsToCheck.every(pathToCheck =>
    workingPaths.some(workingPath =>
      pathInWorkingPath(pathToCheck, workingPath),
    ),
  )
}

export function pathInWorkingPath(path: string, workingPath: string): boolean {
  const absolutePath = expandPath(path)
  const absoluteWorkingPath = expandPath(workingPath)

  // 在 macOS 上，处理常见的符号链接问题：
  // - /var -> /private/var
  // - /tmp -> /private/tmp
  const normalizedPath = absolutePath
    .replace(/^\/private\/var\//, '/var/')
    .replace(/^\/private\/tmp(\/|$)/, '/tmp$1')
  const normalizedWorkingPath = absoluteWorkingPath
    .replace(/^\/private\/var\//, '/var/')
    .replace(/^\/private\/tmp(\/|$)/, '/tmp$1')

  // 进行不区分大小写的规范化比较，防止在不区分大小写的文件系统
  // （macOS/Windows）上绕过安全检查，例如 .cLauDe/CoMmAnDs
  const caseNormalizedPath = normalizeCaseForComparison(normalizedPath)
  const caseNormalizedWorkingPath = normalizeCaseForComparison(
    normalizedWorkingPath,
  )

  // 使用跨平台相对路径辅助函数
  const relative = relativePath(caseNormalizedWorkingPath, caseNormalizedPath)

  // 相同路径
  if (relative === '') {
    return true
  }

  if (containsPathTraversal(relative)) {
    return false
  }

  // 路径在内部（相对路径且不上溯）
  return !posix.isAbsolute(relative)
}

function rootPathForSource(source: PermissionRuleSource): string {
  switch (source) {
    case 'cliArg':
    case 'command':
    case 'session':
      return expandPath(getOriginalCwd())
    case 'userSettings':
    case 'policySettings':
    case 'projectSettings':
    case 'localSettings':
    case 'flagSettings':
      return getSettingsRootPathForSource(source)
  }
}

function prependDirSep(path: string): string {
  return posix.join(DIR_SEP, path)
}

function normalizePatternToPath({
  patternRoot,
  pattern,
  rootPath,
}: {
  patternRoot: string
  pattern: string
  rootPath: string
}): string | null {
  // 如果模式根 + 模式组合从我们的参考根开始
  const fullPattern = posix.join(patternRoot, pattern)
  if (patternRoot === rootPath) {
    // 如果模式根与我们的参考根完全匹配，则无需更改
    return prependDirSep(pattern)
  } else if (fullPattern.startsWith(`${rootPath}${DIR_SEP}`)) {
    // 提取相对部分
    const relativePart = fullPattern.slice(rootPath.length)
    return prependDirSep(relativePart)
  } else {
    // 处理在参考根内部但不以它开头的模式
    const relativePath = posix.relative(rootPath, patternRoot)
    if (
      !relativePath ||
      relativePath.startsWith(`..${DIR_SEP}`) ||
      relativePath === '..'
    ) {
      // 模式在参考根之外，因此可以跳过
      return null
    } else {
      const relativePattern = posix.join(relativePath, pattern)
      return prependDirSep(relativePattern)
    }
  }
}

export function normalizePatternsToPath(
  patternsByRoot: Map<string | null, string[]>,
  root: string,
): string[] {
  // null 根表示模式可以在任何地方匹配
  const result = new Set(patternsByRoot.get(null) ?? [])

  for (const [patternRoot, patterns] of patternsByRoot.entries()) {
    if (patternRoot === null) {
      // 已添加
      continue
    }

    // 检查每个模式，查看完整路径是否从我们的参考根开始
    for (const pattern of patterns) {
      const normalizedPattern = normalizePatternToPath({
        patternRoot,
        pattern,
        rootPath: root,
      })
      if (normalizedPattern) {
        result.add(normalizedPattern)
      }
    }
  }
  return Array.from(result)
}

/**
 * 收集文件读权限的所有拒绝规则并返回它们的 ignore 模式
 * 每个模式必须相对于其根（map 的键）解析
 * null 键用于没有根的模式
 *
 * 这用于隐藏被 Read 拒绝规则阻止的文件。
 *
 * @param toolPermissionContext
 */
export function getFileReadIgnorePatterns(
  toolPermissionContext: ToolPermissionContext,
): Map<string | null, string[]> {
  const patternsByRoot = getPatternsByRoot(
    toolPermissionContext,
    'read',
    'deny',
  )
  const result = new Map<string | null, string[]>()
  for (const [patternRoot, patternMap] of patternsByRoot.entries()) {
    result.set(patternRoot, Array.from(patternMap.keys()))
  }

  return result
}

function patternWithRoot(
  pattern: string,
  source: PermissionRuleSource,
): {
  relativePattern: string
  root: string | null
} {
  if (pattern.startsWith(`${DIR_SEP}${DIR_SEP}`)) {
    // 以 // 开头的模式相对于 / 解析
    const patternWithoutDoubleSlash = pattern.slice(1)

    // 在 Windows 上，检查这是否为 POSIX 风格的盘符路径，如 //c/Users/...
    // 注意：UNC 路径（//server/share）不会匹配此正则，将作为
    // 根相对模式处理，将来可能需要单独处理
    if (
      getPlatform() === 'windows' &&
      patternWithoutDoubleSlash.match(/^\/[a-z]\//i)
    ) {
      // 将 POSIX 路径转换为 Windows 格式
      // 模式类似于 /c/Users/...，因此将其转换为 C:\Users\...
      const driveLetter = patternWithoutDoubleSlash[1]?.toUpperCase() ?? 'C'
      // Keep the pattern in POSIX format since relativePath returns POSIX paths
      const pathAfterDrive = patternWithoutDoubleSlash.slice(2)

      // 提取盘符根目录（C:\）和模式的其余部分
      const driveRoot = `${driveLetter}:\\`
      const relativeFromDrive = pathAfterDrive.startsWith('/')
        ? pathAfterDrive.slice(1)
        : pathAfterDrive

      return {
        relativePattern: relativeFromDrive,
        root: driveRoot,
      }
    }

    return {
      relativePattern: patternWithoutDoubleSlash,
      root: DIR_SEP,
    }
  } else if (pattern.startsWith(`~${DIR_SEP}`)) {
    // 以 ~/ 开头的模式相对于 homedir 解析
    return {
      relativePattern: pattern.slice(1),
      root: homedir().normalize('NFC'),
    }
  } else if (pattern.startsWith(DIR_SEP)) {
    // 以 / 开头的模式相对于存储设置的目录解析（不含 .zy/）
    return {
      relativePattern: pattern,
      root: rootPathForSource(source),
    }
  }
  // 未指定根，将其与其他所有模式放在一起
  // 规范化以 "./" 开头的模式以移除前缀
  // 这确保像 "./.env" 这样的模式能匹配像 ".env" 这样的文件
  let normalizedPattern = pattern
  if (pattern.startsWith(`.${DIR_SEP}`)) {
    normalizedPattern = pattern.slice(2)
  }
  return {
    relativePattern: normalizedPattern,
    root: null,
  }
}

function getPatternsByRoot(
  toolPermissionContext: ToolPermissionContext,
  toolType: 'edit' | 'read',
  behavior: 'allow' | 'deny' | 'ask',
): Map<string | null, Map<string, PermissionRule>> {
  const toolName = (() => {
    switch (toolType) {
      case 'edit':
        // 将 Edit 工具规则应用于任何编辑文件的工具
        return FILE_EDIT_TOOL_NAME
      case 'read':
        // 将 Read 工具规则应用于任何读取文件的工具
        return FILE_READ_TOOL_NAME
    }
  })()

  const rules = getRuleByContentsForToolName(
    toolPermissionContext,
    toolName,
    behavior,
  )
  // 相对于路径根据来源解析规则
  const patternsByRoot = new Map<string | null, Map<string, PermissionRule>>()
  for (const [pattern, rule] of rules.entries()) {
    const { relativePattern, root } = patternWithRoot(pattern, rule.source)
    let patternsForRoot = patternsByRoot.get(root)
    if (patternsForRoot === undefined) {
      patternsForRoot = new Map<string, PermissionRule>()
      patternsByRoot.set(root, patternsForRoot)
    }
    // 以根为键存储规则
    patternsForRoot.set(relativePattern, rule)
  }
  return patternsByRoot
}

export function matchingRuleForInput(
  path: string,
  toolPermissionContext: ToolPermissionContext,
  toolType: 'edit' | 'read',
  behavior: 'allow' | 'deny' | 'ask',
): PermissionRule | null {
  let fileAbsolutePath = expandPath(path)

  // 在 Windows 上，转换为 POSIX 格式以与权限模式匹配
  if (getPlatform() === 'windows' && fileAbsolutePath.includes('\\')) {
    fileAbsolutePath = windowsPathToPosixPath(fileAbsolutePath)
  }

  const patternsByRoot = getPatternsByRoot(
    toolPermissionContext,
    toolType,
    behavior,
  )

  // Check each root for a matching pattern
  for (const [root, patternMap] of patternsByRoot.entries()) {
    // 为 ignore 库转换模式
    const patterns = Array.from(patternMap.keys()).map(pattern => {
      let adjustedPattern = pattern

      // 移除 /** 后缀 — ignore 库将 'path' 视为同时匹配
      // 路径本身和其中的所有内容
      if (adjustedPattern.endsWith('/**')) {
        adjustedPattern = adjustedPattern.slice(0, -3)
      }

      return adjustedPattern
    })

    const ig = ignore().add(patterns)

    // 使用跨平台相对路径辅助函数 for POSIX-style patterns
    const relativePathStr = relativePath(
      root ?? getCwd(),
      fileAbsolutePath ?? getCwd(),
    )

    if (relativePathStr.startsWith(`..${DIR_SEP}`)) {
      // 路径在根之外，因此忽略它
      continue
    }

    // 重要：如果传入空字符串，ig.test 会抛出异常
    if (!relativePathStr) {
      continue
    }

    const igResult = ig.test(relativePathStr)

    if (igResult.ignored && igResult.rule) {
      // 将匹配的模式映射回原始规则
      const originalPattern = igResult.rule.pattern

      // 检查这是否是我们简化的 /** 模式
      const withWildcard = originalPattern + '/**'
      if (patternMap.has(withWildcard)) {
        return patternMap.get(withWildcard) ?? null
      }

      return patternMap.get(originalPattern) ?? null
    }
  }

  // 未找到匹配的规则
  return null
}

/**
 * 指定工具和工具输入的读权限结果
 */
export function checkReadPermissionForTool(
  tool: Tool,
  input: { [key: string]: unknown },
  toolPermissionContext: ToolPermissionContext,
): PermissionDecision {
  if (typeof tool.getPath !== 'function') {
    return {
      behavior: 'ask',
      message: `ZY requested permissions to use ${tool.name}, but you haven't granted it yet.`,
    }
  }
  const path = tool.getPath(input)

  // 获取要检查的路径（包括原始路径和解析的符号链接）。
  // 在此处计算一次并传递到 checkWritePermissionForTool →
  // checkPathSafetyForAutoEdit → pathInAllowedWorkingPath，以避免对
  // 同一路径重复执行 existsSync/lstatSync/realpathSync 系统调用
  // （此前每次 Read 权限检查 = 6× = 30 次系统调用）。
  const pathsToCheck = getPathsForPermissionCheck(path)

  // 1. 纵深防御：尽早阻止 UNC 路径（在其他检查之前）
  // 这捕获以 \\ 或 // 开头的可能访问网络资源的路径
  // 这可能捕获一些 containsVulnerableUncPath 未检测到的 UNC 模式
  for (const pathToCheck of pathsToCheck) {
    if (pathToCheck.startsWith('\\\\') || pathToCheck.startsWith('//')) {
      return {
        behavior: 'ask',
        message: `ZY requested permissions to read from ${path}, which appears to be a UNC path that could access network resources.`,
        decisionReason: {
          type: 'other',
          reason: 'UNC path detected (defense-in-depth check)',
        },
      }
    }
  }

  // 2. 检查可疑 Windows 路径模式（纵深防御）
  for (const pathToCheck of pathsToCheck) {
    if (hasSuspiciousWindowsPathPattern(pathToCheck)) {
      return {
        behavior: 'ask',
        message: `ZY requested permissions to read from ${path}, which contains a suspicious Windows path pattern that requires manual approval.`,
        decisionReason: {
          type: 'other',
          reason:
            'Path contains suspicious Windows-specific patterns (alternate data streams, short names, long path prefixes, or three or more consecutive dots) that require manual verification',
        },
      }
    }
  }

  // 3. 首先检查读特定的拒绝规则 — 检查原始路径和解析的符号链接路径
  // 安全：这必须在任何放行检查（包括"编辑权限隐含读权限"）之前
  // 以防止绕过显式的读拒绝规则
  for (const pathToCheck of pathsToCheck) {
    const denyRule = matchingRuleForInput(
      pathToCheck,
      toolPermissionContext,
      'read',
      'deny',
    )
    if (denyRule) {
      return {
        behavior: 'deny',
        message: `Permission to read ${path} has been denied.`,
        decisionReason: {
          type: 'rule',
          rule: denyRule,
        },
      }
    }
  }

  // 4. 检查读特定的 ask 规则 — 检查原始路径和解析的符号链接路径
  // 安全：这必须在隐式放行检查之前，以确保显式 ask 规则被遵守
  for (const pathToCheck of pathsToCheck) {
    const askRule = matchingRuleForInput(
      pathToCheck,
      toolPermissionContext,
      'read',
      'ask',
    )
    if (askRule) {
      return {
        behavior: 'ask',
        message: `ZY requested permissions to read from ${path}, but you haven't granted it yet.`,
        decisionReason: {
          type: 'rule',
          rule: askRule,
        },
      }
    }
  }

  // 5. 编辑权限隐含读权限（但仅在没有读特定的拒绝/ask 规则时）
  // 我们在读特定规则之后检查此内容，以便显式读限制优先
  const editResult = checkWritePermissionForTool(
    tool,
    input,
    toolPermissionContext,
    pathsToCheck,
  )
  if (editResult.behavior === 'allow') {
    return editResult
  }

  // 6. 允许在工作目录中读取
  const isInWorkingDir = pathInAllowedWorkingPath(
    path,
    toolPermissionContext,
    pathsToCheck,
  )
  if (isInWorkingDir) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'mode',
        mode: 'default',
      },
    }
  }

  // 7. 允许从内部 harness 路径读取（session-memory、plans、tool-results）
  const absolutePath = expandPath(path)
  const internalReadResult = checkReadableInternalPath(absolutePath, input)
  if (internalReadResult.behavior !== 'passthrough') {
    return internalReadResult
  }

  // 8. 检查放行规则
  const allowRule = matchingRuleForInput(
    path,
    toolPermissionContext,
    'read',
    'allow',
  )
  if (allowRule) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'rule',
        rule: allowRule,
      },
    }
  }

  // 12. 默认请求权限
  // 此时，isInWorkingDir 为 false（来自步骤 #6），因此路径在允许的工作目录之外
  return {
    behavior: 'ask',
    message: `ZY requested permissions to read from ${path}, but you haven't granted it yet.`,
    suggestions: generateSuggestions(
      path,
      'read',
      toolPermissionContext,
      pathsToCheck,
    ),
    decisionReason: {
      type: 'workingDir',
      reason: 'Path is outside allowed working directories',
    },
  }
}

/**
 * 指定工具和工具输入的写权限结果。
 *
 * @param precomputedPathsToCheck - `getPathsForPermissionCheck(tool.getPath(input))`
 *   的可选缓存结果。调用者必须在同一个同步帧中从相同的 `tool`
 *   和 `input` 派生此值 — `path` 在内部重新派生用于错误消息
 *   和内部路径检查，因此过时的值会静默检查错误路径的拒绝规则。
 */
export function checkWritePermissionForTool<Input extends AnyObject>(
  tool: Tool<Input>,
  input: z.infer<Input>,
  toolPermissionContext: ToolPermissionContext,
  precomputedPathsToCheck?: readonly string[],
): PermissionDecision {
  if (typeof tool.getPath !== 'function') {
    return {
      behavior: 'ask',
      message: `ZY requested permissions to use ${tool.name}, but you haven't granted it yet.`,
    }
  }
  const path = tool.getPath(input)

  // 1. 检查拒绝规则 — 检查原始路径和解析的符号链接路径
  const pathsToCheck =
    precomputedPathsToCheck ?? getPathsForPermissionCheck(path)
  for (const pathToCheck of pathsToCheck) {
    const denyRule = matchingRuleForInput(
      pathToCheck,
      toolPermissionContext,
      'edit',
      'deny',
    )
    if (denyRule) {
      return {
        behavior: 'deny',
        message: `Permission to edit ${path} has been denied.`,
        decisionReason: {
          type: 'rule',
          rule: denyRule,
        },
      }
    }
  }

  // 1.5. 允许写入内部可编辑路径（plan 文件、暂存目录）
  // 这必须在 isDangerousFilePathToAutoEdit 检查之前，因为 .zy 是危险目录
  const absolutePathForEdit = expandPath(path)
  const internalEditResult = checkEditableInternalPath(
    absolutePathForEdit,
    input,
  )
  if (internalEditResult.behavior !== 'passthrough') {
    return internalEditResult
  }

  // 1.6. 在安全检查之前检查 .zy/** 放行规则
  // 这允许会话级权限绕过 .zy/ 的安全块
  // 我们仅允许会话级规则，以防止用户意外地
  // 永久授予对 .zy/ 文件夹的广泛访问。
  //
  // matchingRuleForInput 返回所有来源中的第一个匹配。如果用户
  // 在 userSettings 中也有更广泛的 Edit(.zy) 规则（例如来自 sandbox
  // write-allow 转换），则该规则会首先被找到，下方的来源检查
  // 会失败。将搜索范围限制为仅会话级规则，以便对话框中的
  // "允许 ZY 在此会话期间编辑其自身设置"选项真正有效。
  const ZyFolderAllowRule = matchingRuleForInput(
    path,
    {
      ...toolPermissionContext,
      alwaysAllowRules: {
        session: toolPermissionContext.alwaysAllowRules.session ?? [],
      },
    },
    'edit',
    'allow',
  )
  if (ZyFolderAllowRule) {
    // 检查此规则是否在 .zy/ 范围内（项目级或全局级）。
    // 接受宽泛模式（'/.zy/**'、'~/.zy/**'）和
    // 缩小模式如 '/.zy/skills/my-skill/**'，以便用户可以授予
    // 对单个技能的会话访问，而不暴露 settings.json
    // 或 hooks/。规则已通过 matchingRuleForInput 匹配路径；
    // 这是额外的范围检查。拒绝 '..' 以防止如
    // '/.zy/../**' 这样的规则将此绕过泄漏到 .zy/ 之外。
    const ruleContent = ZyFolderAllowRule.ruleValue.ruleContent
    if (
      ruleContent &&
      (ruleContent.startsWith(CLAUDE_FOLDER_PERMISSION_PATTERN.slice(0, -2)) ||
        ruleContent.startsWith(
          GLOBAL_CLAUDE_FOLDER_PERMISSION_PATTERN.slice(0, -2),
        )) &&
      !ruleContent.includes('..') &&
      ruleContent.endsWith('/**')
    ) {
      return {
        behavior: 'allow',
        updatedInput: input,
        decisionReason: {
          type: 'rule',
          rule: ZyFolderAllowRule,
        },
      }
    }
  }

  // 1.7. 检查全面的安全验证（Windows 模式、ZY 配置、危险文件）
  // 这必须在检查放行规则之前，以防止用户意外地授予
  // 编辑受保护文件的权限
  const safetyCheck = checkPathSafetyForAutoEdit(path, pathsToCheck)
  if (!safetyCheck.safe) {
    // SDK 建议：如果在 .zy/skills/{name}/ 下，发出缩小的
    // 会话范围 addRules，步骤 1.6 将在下次调用时遵守。
    // 其他所有内容（.zy/settings.json、.git/、.vscode/、.idea/）回退到
    // generateSuggestions — 其 setMode 建议不会绕过
    // 此检查，但保留它可以避免令人惊讶的空数组。
    const skillScope = getZySkillScope(path)
    const safetySuggestions: PermissionUpdate[] = skillScope
      ? [
          {
            type: 'addRules',
            rules: [
              {
                toolName: FILE_EDIT_TOOL_NAME,
                ruleContent: skillScope.pattern,
              },
            ],
            behavior: 'allow',
            destination: 'session',
          },
        ]
      : generateSuggestions(path, 'write', toolPermissionContext, pathsToCheck)
    return {
      behavior: 'ask',
      message: (safetyCheck as any).message,
      suggestions: safetySuggestions,
      decisionReason: {
        type: 'safetyCheck',
        reason: (safetyCheck as any).message,
        classifierApprovable: (safetyCheck as any).classifierApprovable,
      },
    }
  }

  // 2. 检查 ask 规则 — 检查原始路径和解析的符号链接路径
  for (const pathToCheck of pathsToCheck) {
    const askRule = matchingRuleForInput(
      pathToCheck,
      toolPermissionContext,
      'edit',
      'ask',
    )
    if (askRule) {
      return {
        behavior: 'ask',
        message: `ZY requested permissions to write to ${path}, but you haven't granted it yet.`,
        decisionReason: {
          type: 'rule',
          rule: askRule,
        },
      }
    }
  }

  // 3. 如果在 acceptEdits 或 sandboxBashMode 模式下，允许原始 cwd 中的所有写入
  const isInWorkingDir = pathInAllowedWorkingPath(
    path,
    toolPermissionContext,
    pathsToCheck,
  )
  if (toolPermissionContext.mode === 'acceptEdits' && isInWorkingDir) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'mode',
        mode: toolPermissionContext.mode,
      },
    }
  }

  // 4. 检查放行规则
  const allowRule = matchingRuleForInput(
    path,
    toolPermissionContext,
    'edit',
    'allow',
  )
  if (allowRule) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'rule',
        rule: allowRule,
      },
    }
  }

  // 5. 默认请求权限
  return {
    behavior: 'ask',
    message: `ZY requested permissions to write to ${path}, but you haven't granted it yet.`,
    suggestions: generateSuggestions(
      path,
      'write',
      toolPermissionContext,
      pathsToCheck,
    ),
    decisionReason: !isInWorkingDir
      ? {
          type: 'workingDir',
          reason: 'Path is outside allowed working directories',
        }
      : undefined,
  }
}

export function generateSuggestions(
  filePath: string,
  operationType: 'read' | 'write' | 'create',
  toolPermissionContext: ToolPermissionContext,
  precomputedPathsToCheck?: readonly string[],
): PermissionUpdate[] {
  const isOutsideWorkingDir = !pathInAllowedWorkingPath(
    filePath,
    toolPermissionContext,
    precomputedPathsToCheck,
  )

  if (operationType === 'read' && isOutsideWorkingDir) {
    // 对于读操作在工作目录之外，添加 Read 规则
    // 重要：包括符号链接路径和解析路径，以便后续检查通过
    const dirPath = getDirectoryForPath(filePath)
    const dirsToAdd = getPathsForPermissionCheck(dirPath)

    const suggestions = dirsToAdd
      .map(dir => createReadRuleSuggestion(dir, 'session'))
      .filter((s): s is PermissionUpdate => s !== undefined)

    return suggestions
  }

  // 仅在 setMode:acceptEdits 是升级时才建议。在 auto
  // 模式下，分类器已自动批准编辑；在 bypassPermissions
  // 下一切都被允许；在 acceptEdits 下这是无操作。仍然建议它
  // 并让 SDK 主机在"始终允许"时应用，会静默
  // 将 auto 降级为 acceptEdits，然后提示 MCP/Bash。
  const shouldSuggestAcceptEdits =
    toolPermissionContext.mode === 'default' ||
    toolPermissionContext.mode === 'plan'

  if (operationType === 'write' || operationType === 'create') {
    const updates: PermissionUpdate[] = shouldSuggestAcceptEdits
      ? [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]
      : []

    if (isOutsideWorkingDir) {
      // 对于写操作在工作目录之外，也添加目录
      // 重要：包括符号链接路径和解析路径，以便后续检查通过
      const dirPath = getDirectoryForPath(filePath)
      const dirsToAdd = getPathsForPermissionCheck(dirPath)

      updates.push({
        type: 'addDirectories',
        directories: dirsToAdd,
        destination: 'session',
      })
    }

    return updates
  }

  // 对于读操作在工作目录内，仅更改模式
  return shouldSuggestAcceptEdits
    ? [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]
    : []
}

/**
 * 检查路径是否为可以无需权限编辑的内部路径。
 * 返回 PermissionResult — 如果匹配则返回 'allow'，否则返回 'passthrough' 以继续检查。
 */
export function checkEditableInternalPath(
  absolutePath: string,
  input: { [key: string]: unknown },
): PermissionResult {
  // 安全：规范化路径以防止通过 .. 段进行穿越绕过
  // 这是纵深防御；各个辅助函数也进行规范化
  const normalizedPath = normalize(absolutePath)

  // 当前会话的 plan 文件
  if (isSessionPlanFile(normalizedPath)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Plan files for current session are allowed for writing',
      },
    }
  }

  // 当前会话的暂存目录
  if (isScratchpadPath(normalizedPath)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Scratchpad files for current session are allowed for writing',
      },
    }
  }

  // 模板作业自身目录。环境变量键硬编码
  // （而非从 jobs/state 导入 JOB_ENV_KEY），因此 tree-shaking 在外部
  // 构建中消除该字符串 — spawn.test.ts 断言字符串匹配。劫持守卫：env
  // 变量值本身必须解析到 ~/.zy/jobs/ 下。符号链接守卫：每个
  // 解析后的目标形式（词法 + 符号链）必须落在某个
  // 解析后的作业目录形式下，因此作业目录内指向
  // 例如 ~/.ssh/authorized_keys 的符号链接不会获得免费写入。
  // 解析两侧处理 macOS /tmp → /private/tmp 的情况，
  // 其中配置目录位于符号链接的根下。
  if (feature('TEMPLATES')) {
    const jobDir = process.env.CLAUDE_JOB_DIR
    if (jobDir) {
      const jobsRoot = join(getZyConfigHomeDir(), 'jobs')
      const jobDirForms = getPathsForPermissionCheck(jobDir).map(normalize)
      const jobsRootForms = getPathsForPermissionCheck(jobsRoot).map(normalize)
      // 劫持守卫：作业目录的每个解析形式必须位于
      // 作业根的某个解析形式之下。解析两侧处理
      // ~/.zy 是符号链接（例如指向 /data/zy-config）的情况。
      const isUnderJobsRoot = jobDirForms.every(jd =>
        jobsRootForms.some(jr => jd.startsWith(jr + sep)),
      )
      if (isUnderJobsRoot) {
        const targetForms = getPathsForPermissionCheck(absolutePath)
        const allInsideJobDir = targetForms.every(p => {
          const np = normalize(p)
          return jobDirForms.some(jd => np === jd || np.startsWith(jd + sep))
        })
        if (allInsideJobDir) {
          return {
            behavior: 'allow',
            updatedInput: input,
            decisionReason: {
              type: 'other',
              reason:
                'Job directory files for current job are allowed for writing',
            },
          }
        }
      }
    }
  }

  // Agent 内存目录（用于自改进代理）
  if (isAgentMemoryPath(normalizedPath)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Agent memory files are allowed for writing',
      },
    }
  }

  // Memdir 目录（用于跨会话学习的持久内存）
  // 此安全检查前 carve-out 存在是因为默认路径位于
  // ~/.zy/ 下，这在 DANGEROUS_DIRECTORIES 中。CLAUDE_COWORK_MEMORY_PATH_OVERRIDE
  // 覆盖是调用者指定的任意目录，没有此类冲突，
  // 因此它在此不获得特殊权限处理 — 写入走正常
  // 权限流程（步骤 5 → ask）。希望静默内存的 SDK 调用者应
  // 为覆盖路径传递放行规则。
  if (!hasAutoMemPathOverride() && isAutoMemPath(normalizedPath)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'auto memory files are allowed for writing',
      },
    }
  }

  // .zy/launch.json — 桌面预览配置（开发服务器命令 + 端口）。
  // 桌面的 preview_start MCP 工具指示 ZY 作为预览工作流的一部分
  // 创建/更新此文件。没有此 carve-out，.zy/ DANGEROUS_DIRECTORIES
  // 检查会提示它，这在 SDK 模式下会级联：用户点击"始终允许"
  // → 应用 setMode:acceptEdits 建议 → 从 auto 模式静默降级。
  // 仅匹配项目级 .zy/（而非 ~/.zy/），因为 launch.json 是每个项目的。
  if (
    normalizeCaseForComparison(normalizedPath) ===
    normalizeCaseForComparison(join(getOriginalCwd(), '.zy', 'launch.json'))
  ) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Preview launch config is allowed for writing',
      },
    }
  }

  return { behavior: 'passthrough', message: '' }
}

/**
 * 检查路径是否为可以无需权限读取的内部路径。
 * 返回 PermissionResult — 如果匹配则返回 'allow'，否则返回 'passthrough' 以继续检查。
 */
export function checkReadableInternalPath(
  absolutePath: string,
  input: { [key: string]: unknown },
): PermissionResult {
  // 安全：规范化路径以防止通过 .. 段进行穿越绕过
  // 这是纵深防御；各个辅助函数也进行规范化
  const normalizedPath = normalize(absolutePath)

  // 会话内存目录
  if (isSessionMemoryPath(normalizedPath)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Session memory files are allowed for reading',
      },
    }
  }

  // 项目目录（用于读取过去的会话内存）
  // 路径格式：~/.zy/projects/{sanitized-cwd}/...
  if (isProjectDirPath(normalizedPath)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Project directory files are allowed for reading',
      },
    }
  }

  // 当前会话的 plan 文件
  if (isSessionPlanFile(normalizedPath)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Plan files for current session are allowed for reading',
      },
    }
  }

  // 工具结果目录（持久化大输出）
  // 使用路径分隔符后缀防止路径穿越（例如 tool-results-evil/）
  const toolResultsDir = getToolResultsDir()
  const toolResultsDirWithSep = toolResultsDir.endsWith(sep)
    ? toolResultsDir
    : toolResultsDir + sep
  if (
    normalizedPath === toolResultsDir ||
    normalizedPath.startsWith(toolResultsDirWithSep)
  ) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Tool result files are allowed for reading',
      },
    }
  }

  // 当前会话的暂存目录
  if (isScratchpadPath(normalizedPath)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Scratchpad files for current session are allowed for reading',
      },
    }
  }

  // 项目临时目录（/tmp/zy/{sanitized-cwd}/）
  // 有意允许读取此项目中所有会话的文件，而不仅仅是当前会话。
  // 这启用了同一项目临时空间内的跨会话文件访问。
  const projectTempDir = getProjectTempDir()
  if (normalizedPath.startsWith(projectTempDir)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Project temp directory files are allowed for reading',
      },
    }
  }

  // Agent 内存目录（用于自改进代理）
  if (isAgentMemoryPath(normalizedPath)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Agent memory files are allowed for reading',
      },
    }
  }

  // Memdir directory (persistent memory for cross-session learning)
  if (isAutoMemPath(normalizedPath)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'auto memory files are allowed for reading',
      },
    }
  }

  // Tasks 目录（~/.zy/tasks/）用于 swarm 任务协调
  const tasksDir = join(getZyConfigHomeDir(), 'tasks') + sep
  if (
    normalizedPath === tasksDir.slice(0, -1) ||
    normalizedPath.startsWith(tasksDir)
  ) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Task files are allowed for reading',
      },
    }
  }

  // Teams 目录（~/.zy/teams/）用于 swarm 协调
  const teamsReadDir = join(getZyConfigHomeDir(), 'teams') + sep
  if (
    normalizedPath === teamsReadDir.slice(0, -1) ||
    normalizedPath.startsWith(teamsReadDir)
  ) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Team files are allowed for reading',
      },
    }
  }

  // 首次调用时提取的打包技能参考文件。
  // 安全：参见 getBundledSkillsRoot() — 路径中的每进程 nonce
  // 是决定性防御；仅 uid/VERSION 是公开知识且
  // 可被抢占。我们在调用时先写后读，因此此
  // 子树下的内容由 harness 控制。
  const bundledSkillsRoot = getBundledSkillsRoot() + sep
  if (normalizedPath.startsWith(bundledSkillsRoot)) {
    return {
      behavior: 'allow',
      updatedInput: input,
      decisionReason: {
        type: 'other',
        reason: 'Bundled skill reference files are allowed for reading',
      },
    }
  }

  return { behavior: 'passthrough', message: '' }
}
