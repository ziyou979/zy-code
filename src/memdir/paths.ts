import { homedir } from 'node:os'
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import memoize from 'lodash-es/memoize.js'
import { getIsNonInteractiveSession } from 'src/bootstrap/runtime/runtimeContext.js'
import { getProjectRoot } from 'src/bootstrap/runtime/runtimeContext.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js'
import { getZyConfigHomeDir, isEnvDefinedFalsy, isEnvTruthy } from '../services/infra/envUtils.js'
import { findCanonicalGitRoot } from '../services/infra/git.js'
import { sanitizePath } from '../utils/path.js'
import { getInitialSettings, getSettingsForSource } from '../services/settings/settings.js'

/**
 * auto-memory feature（memdir、agent memory、过往 session 搜索）是否启用。
 * 默认启用。优先级链（首个已定义的值生效）：
 *   1. ZY_CODE_DISABLE_AUTO_MEMORY env var (1/true → OFF, 0/false → ON)
 *   2. ZY_CODE_SIMPLE (--bare) → OFF
 *   3. CCR without persistent storage → OFF (no ZY_CODE_REMOTE_MEMORY_DIR)
 *   4. autoMemoryEnabled in settings.json (supports project-level opt-out)
 *   5. 默认：启用
 */
export function isAutoMemoryEnabled(): boolean {
  const envVal = process.env.ZY_CODE_DISABLE_AUTO_MEMORY
  if (isEnvTruthy(envVal)) {
    return false
  }
  if (isEnvDefinedFalsy(envVal)) {
    return true
  }
  // --bare / SIMPLE：prompts.ts 已通过 SIMPLE 提前返回从 system prompt 中移除 memory 部分；
  // 此 gate 还会停止其余功能（extractMemories turn 结束 fork、autoDream、/remember、/dream、team 同步）。
  if (isEnvTruthy(process.env.ZY_CODE_SIMPLE)) {
    return false
  }
  if (isEnvTruthy(process.env.ZY_CODE_REMOTE) && !process.env.ZY_CODE_REMOTE_MEMORY_DIR) {
    return false
  }
  const settings = getInitialSettings()
  if (settings.autoMemoryEnabled !== undefined) {
    return settings.autoMemoryEnabled
  }
  return true
}

/**
 * extract-memories 后台 agent 是否会在本 session 中运行。
 *
 * 无论该 gate 状态如何，主 agent 的 prompt 始终包含完整保存指引。
 * 主 agent 写入 memory 时，后台 agent 会跳过该范围（extractMemories.ts 中的 hasMemoryWritesSince）；
 * 主 agent 未写入时，后台 agent 会补上遗漏内容。
 *
 * 调用方还必须检查 feature('EXTRACT_MEMORIES')。该检查不能放入此 helper，
 * 因为 feature() 只有直接用在 `if` 条件中时才能 tree-shake。
 */
export function isExtractModeActive(): boolean {
  if (!getFeatureValue_CACHED_MAY_BE_STALE('zy_passport_quail', false)) {
    return false
  }
  return (
    !getIsNonInteractiveSession() || getFeatureValue_CACHED_MAY_BE_STALE('zy_slate_thimble', false)
  )
}

/**
 * 返回持久 memory 存储的根目录。
 * 解析顺序：
 *   1. ZY_CODE_REMOTE_MEMORY_DIR env var（显式覆盖，由 CCR 设置）
 *   2. ~/.zy（默认配置主目录）
 */
export function getMemoryBaseDir(): string {
  if (process.env.ZY_CODE_REMOTE_MEMORY_DIR) {
    return process.env.ZY_CODE_REMOTE_MEMORY_DIR
  }
  return getZyConfigHomeDir()
}

const AUTO_MEM_DIRNAME = 'memory'
const AUTO_MEM_ENTRYPOINT_NAME = 'MEMORY.md'

/**
 * 规范化并校验候选 auto-memory 目录路径。
 *
 * 安全：拒绝作为读取 allowlist 根目录会带来危险，
 * 或 normalize() 无法完全解析的路径：
 * - relative (!isAbsolute): "../foo" — would be interpreted relative to CWD
 * - root/near-root (length < 3): "/" → "" after strip; "/a" too short
 * - Windows drive-root (C: regex): "C:\" → "C:" after strip
 * - UNC paths (\\server\share): network paths — opaque trust boundary
 * - null byte: survives normalize(), can truncate in syscalls
 *
 * 返回规范化后且末尾恰好有一个分隔符的路径；
 * 路径未设置、为空或被拒绝时返回 undefined。
 */
function validateMemoryPath(raw: string | undefined, expandTilde: boolean): string | undefined {
  if (!raw) {
    return undefined
  }
  let candidate = raw
  // Settings.json 路径支持 ~/ 展开，方便用户使用；env var 覆盖不支持，因为它由
  // Cowork/SDK 以编程方式设置，应始终传入绝对路径。裸 "~"、"~/"、"~/.", "~/.."
  // 等不会展开，否则会让 isAutoMemPath() 匹配整个 $HOME 或其父目录，风险等级与
  // "/" 或 "C:\" 相同。
  if (expandTilde && (candidate.startsWith('~/') || candidate.startsWith('~\\'))) {
    const rest = candidate.slice(2)
    // 拒绝会展开为 $HOME 或其祖先目录的简单余项。
    // normalize('') = '.', normalize('.') = '.', normalize('foo/..') = '.',
    // normalize('..') = '..', normalize('foo/../..') = '..'
    const restNorm = normalize(rest || '.')
    if (restNorm === '.' || restNorm === '..') {
      return undefined
    }
    candidate = join(homedir(), rest)
  }
  // normalize() 可能保留尾部分隔符；先移除，再精确添加一个，
  // 以符合 getAutoMemPath() 的尾部分隔符契约
  const normalized = normalize(candidate).replace(/[/\\]+$/, '')
  if (
    !isAbsolute(normalized) ||
    normalized.length < 3 ||
    /^[A-Za-z]:$/.test(normalized) ||
    normalized.startsWith('\\\\') ||
    normalized.startsWith('//') ||
    normalized.includes('\0')
  ) {
    return undefined
  }
  return (normalized + sep).normalize('NFC')
}

/**
 * 通过 env var 直接覆盖完整 auto-memory 目录路径。设置后，getAutoMemPath()/
 * getAutoMemEntrypoint() 直接返回此路径，不再计算 `{base}/projects/{sanitized-cwd}/memory/`。
 *
 * Cowork 用它把 memory 重定向到 space 范围的挂载点；否则每 session 的 cwd
 * 包含 VM 进程名，会为每个 session 生成不同 project-key。
 */
function getAutoMemPathOverride(): string | undefined {
  return validateMemoryPath(process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE, false)
}

/**
 * Settings.json 对完整 auto-memory 目录路径的覆盖，支持 ~/ 展开以方便用户。
 *
 * 安全边界：有意排除会提交到仓库的 projectSettings（.zy/settings.json）。否则恶意仓库
 * 可设置 autoMemoryDirectory: "~/.ssh"，再通过 filesystem.ts 的写入例外静默获取
 * 敏感目录写权限；该例外在 isAutoMemPath() 匹配且 hasAutoMemPathOverride() 为 false
 * 时触发。此处沿用 hasSkipDangerousModePermissionPrompt() 等相同模式。
 */
function getAutoMemPathSetting(): string | undefined {
  const dir =
    getSettingsForSource('policySettings')?.autoMemoryDirectory ??
    getSettingsForSource('flagSettings')?.autoMemoryDirectory ??
    getSettingsForSource('localSettings')?.autoMemoryDirectory ??
    getSettingsForSource('userSettings')?.autoMemoryDirectory
  return validateMemoryPath(dir, true)
}

/**
 * 检查 CLAUDE_COWORK_MEMORY_PATH_OVERRIDE 是否设置为有效覆盖值。
 * 这表示 SDK 调用方已明确选择使用 auto-memory 机制；例如自定义 system prompt
 * 替代默认值时，可据此决定是否注入 memory prompt。
 */
export function hasAutoMemPathOverride(): boolean {
  return getAutoMemPathOverride() !== undefined
}

/**
 * canonical git repo root 可用时返回它，否则回退到稳定 project root。
 * 使用 findCanonicalGitRoot，使同一仓库的所有 worktree 共享一个 auto-memory 目录
 *（anthropics/zy-code#24382）。
 */
function getAutoMemBase(): string {
  return findCanonicalGitRoot(getProjectRoot()) ?? getProjectRoot()
}

/**
 * 返回 auto-memory 目录路径。
 *
 * 解析顺序：
 *   1. CLAUDE_COWORK_MEMORY_PATH_OVERRIDE env var (full-path override, used by Cowork)
 *   2. autoMemoryDirectory in settings.json (trusted sources only: policy/local/user)
 *   3. <memoryBase>/projects/<sanitized-git-root>/memory/
 *      where memoryBase is resolved by getMemoryBaseDir()
 *
 * 使用 memoize：render 路径调用方（collapseReadSearchGroups →
 * isAutoManagedMemoryFile）会在 Messages 每次重新渲染时按 tool-use 消息触发；
 * 每次 miss 都需执行四次 getSettingsForSource，再进入 parseSettingsFile
 *（realpathSync + readFileSync）。缓存以 projectRoot 为键，使测试在 block 中途修改 mock
 * 后能重新计算；生产环境的 env var/settings.json/ZY_CONFIG_DIR 在 session 内稳定，
 * 测试则通过每例 cache.clear 覆盖。
 */
export const getAutoMemPath = memoize(
  (): string => {
    const override = getAutoMemPathOverride() ?? getAutoMemPathSetting()
    if (override) {
      return override
    }
    const projectsDir = join(getMemoryBaseDir(), 'projects')
    return (join(projectsDir, sanitizePath(getAutoMemBase()), AUTO_MEM_DIRNAME) + sep).normalize(
      'NFC',
    )
  },
  () => getProjectRoot(),
)

/**
 * 返回给定日期的每日日志文件路径，默认为今天。
 * 形状：<autoMemPath>/logs/YYYY/MM/YYYY-MM-DD.md
 *
 * 由 assistant 模式（feature('KAIROS')）使用：agent 工作时不把 MEMORY.md 维护为
 * 实时索引，而是追加到按日期命名的日志文件；独立的夜间 /dream skill 再将这些日志
 * 提炼为主题文件与 MEMORY.md。
 */
export function getAutoMemDailyLogPath(date: Date = new Date()): string {
  const yyyy = date.getFullYear().toString()
  const mm = (date.getMonth() + 1).toString().padStart(2, '0')
  const dd = date.getDate().toString().padStart(2, '0')
  return join(getAutoMemPath(), 'logs', yyyy, mm, `${yyyy}-${mm}-${dd}.md`)
}

/**
 * 返回 auto-memory 入口，即 auto-memory 目录内的 MEMORY.md；
 * 遵循与 getAutoMemPath() 相同的解析顺序。
 */
export function getAutoMemEntrypoint(): string {
  return join(getAutoMemPath(), AUTO_MEM_ENTRYPOINT_NAME)
}

/**
 * 检查绝对路径是否位于 auto-memory 目录内。
 *
 * 设置 CLAUDE_COWORK_MEMORY_PATH_OVERRIDE 后，会与 env-var 覆盖目录匹配。
 * 注意，此时返回 true 不代表拥有写权限；filesystem.ts 的写入例外还受
 * !hasAutoMemPathOverride() 控制，该例外用于绕过 DANGEROUS_DIRECTORIES。
 *
 * settings.json 的 autoMemoryDirectory 会获得写入例外：它来自可信 settings 来源，
 * 是用户的明确选择；projectSettings 已排除，见 getAutoMemPathSetting。
 * 对它而言 hasAutoMemPathOverride() 仍为 false。
 */
export function isAutoMemPath(absolutePath: string): boolean {
  const relativePath = relative(resolve(getAutoMemPath()), resolve(absolutePath))
  return (
    relativePath !== '' &&
    relativePath !== '..' &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  )
}
