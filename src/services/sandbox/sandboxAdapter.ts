/**
 * 封装 @anthropic-ai/sandbox-runtime 并接入 Zy CLI 特有能力的 adapter 层。
 * 本文件连接外部 sandbox-runtime package 与 Zy CLI 的设置系统、tool 集成及附加功能。
 */

import { rmSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import type {
  FsReadRestrictionConfig,
  FsWriteRestrictionConfig,
  IgnoreViolationsConfig,
  NetworkHostPattern,
  NetworkRestrictionConfig,
  SandboxAskCallback,
  SandboxDependencyCheck,
  SandboxRuntimeConfig,
  SandboxViolationEvent,
} from '@anthropic-ai/sandbox-runtime'
import {
  SandboxManager as BaseSandboxManager,
  SandboxRuntimeConfigSchema,
  SandboxViolationStore,
} from '@anthropic-ai/sandbox-runtime'
import { memoize } from 'lodash-es'
import {
  getAdditionalDirectoriesForAgentsMd,
  getCwdState,
  getOriginalCwd,
} from '../../bootstrap/runtime/runtimeContext.js'
import { logForDebugging } from '../../services/infra/debug.js'
import { expandPath } from '../../utils/path.js'
import { getPlatform, type Platform } from '../shell/platform.js'
import { settingsChangeDetector } from '../settings/changeDetector.js'
import { SETTING_SOURCES, type SettingSource } from '../settings/constants.js'
import { getManagedSettingsDropInDir } from '../settings/managedPath.js'
import {
  getInitialSettings,
  getSettingsFilePathForSource,
  getSettingsForSource,
  getSettingsRootPathForSource,
  updateSettingsForSource,
} from '../settings/settings.js'
import type { SettingsJson } from '../settings/types.js'

// ============================================================================
// 设置转换器。
// ============================================================================

import { BASH_TOOL_NAME } from 'src/tools/BashTool/toolName.js'
import { FILE_EDIT_TOOL_NAME } from 'src/tools/FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from 'src/tools/FileReadTool/prompt.js'
import { WEB_FETCH_TOOL_NAME } from 'src/tools/WebFetchTool/prompt.js'
import { errorMessage } from '../../utils/errors.js'
import { getZyTempDir } from '../permissions/scratchpadStorage.js'
import type { PermissionRuleValue } from 'src/types/permissions.js'
import { ripgrepCommand } from '../file-search/ripgrep.js'

// 使用本地副本避免循环依赖：permissions.ts 导入 SandboxManager，
// bashPermissions.ts 又导入 permissions.ts。
function permissionRuleValueFromString(ruleString: string): PermissionRuleValue {
  const matches = ruleString.match(/^([^(]+)\(([^)]+)\)$/)
  if (!matches) {
    return { toolName: ruleString }
  }
  const toolName = matches[1]
  const ruleContent = matches[2]
  if (!toolName || !ruleContent) {
    return { toolName: ruleString }
  }
  return { toolName, ruleContent }
}

function permissionRuleExtractPrefix(permissionRule: string): string | null {
  const match = permissionRule.match(/^(.+):\*$/)
  return match?.[1] ?? null
}

/**
 * 为 sandbox-runtime 解析 ZY Code 特有的路径模式。
 *
 * ZY Code 在权限规则中使用特殊路径前缀：
 * - `//path` → 相对于文件系统根目录的绝对路径（变为 `/path`）
 * - `/path` → 相对于设置文件目录（变为 `$SETTINGS_DIR/path`）
 * - `~/path` → 原样传递，由 sandbox-runtime 处理
 * - `./path` 或 `path` → 原样传递，由 sandbox-runtime 处理
 *
 * 此函数仅处理 CC 特有约定（`//` 和 `/`）。`~/` 和相对路径等标准模式原样传递，
 * 交给 sandbox-runtime 的 normalizePathForSandbox 处理。
 *
 * @param pattern 权限规则中的路径模式
 * @param source 模式所属设置来源，用于解析 `/path` 模式
 */
export function resolvePathPatternForSandbox(pattern: string, source: SettingSource): string {
  // 处理 // 前缀：相对于根目录的绝对路径，属于 CC 特有约定。
  if (pattern.startsWith('//')) {
    return pattern.slice(1) // "//.aws/**" → "/.aws/**"
  }

  // 处理 / 前缀：相对于设置文件目录，属于 CC 特有约定。~/path 和相对路径
  // 原样传递给 sandbox-runtime 处理。
  if (pattern.startsWith('/') && !pattern.startsWith('//')) {
    const root = getSettingsRootPathForSource(source)
    // "/foo/**" 等模式变为 "${root}/foo/**"。
    return resolve(root, pattern.slice(1))
  }

  // 其他模式（~/path、./path、path）原样传递，由 sandbox-runtime 的
  // normalizePathForSandbox 处理。
  return pattern
}

/**
 * 解析 sandbox.filesystem.* 设置中的路径，如 allowWrite、denyWrite。
 *
 * 与权限规则（Edit/Read）不同，这些设置采用标准路径语义：
 * - `/path` → 原样作为绝对路径，而非相对于设置目录
 * - `~/path` → 展开到主目录
 * - `./path` 或 `path` → 相对于设置文件目录
 * - `//path` → 绝对路径；为兼容旧权限规则语法而接受
 *
 * 修复 #30067：resolvePathPatternForSandbox 会按权限规则约定将
 * `/Users/foo/.cargo` 视为相对于设置目录，但用户合理地期望
 * sandbox.filesystem.allowWrite 中的绝对路径原样生效。
 *
 * 此处也直接展开 `~`，不依赖 sandbox-runtime，因为其 getFsWriteConfig()
 * 不会对 allowWrite 路径调用 normalizePathForSandbox，只会移除尾部 glob 后缀。
 */
export function resolveSandboxFilesystemPath(pattern: string, source: SettingSource): string {
  // 旧权限规则转义：//path → /path。保留用于兼容通过在配置中写入
  // //Users/foo/.cargo 来规避 #30067 的用户。
  if (pattern.startsWith('//')) {
    return pattern.slice(1)
  }
  return expandPath(pattern, getSettingsRootPathForSource(source))
}

/**
 * 检查是否只能使用托管 sandbox domain。当 policySettings 中
 * sandbox.network.allowManagedDomainsOnly 为 true 时成立。
 */
export function shouldAllowManagedSandboxDomainsOnly(): boolean {
  return getSettingsForSource('policySettings')?.sandbox?.network?.allowManagedDomainsOnly === true
}

function shouldAllowManagedReadPathsOnly(): boolean {
  return (
    getSettingsForSource('policySettings')?.sandbox?.filesystem?.allowManagedReadPathsOnly === true
  )
}

/**
 * 将 ZY Code 设置格式转换为 SandboxRuntimeConfig 格式；函数导出供测试使用。
 *
 * @param settings 合并后的设置，用于 network、ripgrep 等 sandbox 配置
 */
export function convertToSandboxRuntimeConfig(settings: SettingsJson): SandboxRuntimeConfig {
  const permissions = settings.permissions || {}

  // 从 WebFetch 规则提取网络 domain。
  const allowedDomains: string[] = []
  const deniedDomains: string[] = []

  // 启用 allowManagedSandboxDomainsOnly 时，仅使用策略设置中的 domain。
  if (shouldAllowManagedSandboxDomainsOnly()) {
    const policySettings = getSettingsForSource('policySettings')
    for (const domain of policySettings?.sandbox?.network?.allowedDomains || []) {
      allowedDomains.push(domain)
    }
    for (const ruleString of policySettings?.permissions?.allow || []) {
      const rule = permissionRuleValueFromString(ruleString)
      if (rule.toolName === WEB_FETCH_TOOL_NAME && rule.ruleContent?.startsWith('domain:')) {
        allowedDomains.push(rule.ruleContent.substring('domain:'.length))
      }
    }
  } else {
    for (const domain of settings.sandbox?.network?.allowedDomains || []) {
      allowedDomains.push(domain)
    }
    for (const ruleString of permissions.allow || []) {
      const rule = permissionRuleValueFromString(ruleString)
      if (rule.toolName === WEB_FETCH_TOOL_NAME && rule.ruleContent?.startsWith('domain:')) {
        allowedDomains.push(rule.ruleContent.substring('domain:'.length))
      }
    }
  }

  for (const ruleString of permissions.deny || []) {
    const rule = permissionRuleValueFromString(ruleString)
    if (rule.toolName === WEB_FETCH_TOOL_NAME && rule.ruleContent?.startsWith('domain:')) {
      deniedDomains.push(rule.ruleContent.substring('domain:'.length))
    }
  }

  // 从 Edit 和 Read 规则提取文件系统路径。始终将当前目录和 Zy 临时目录设为可写；
  // Shell.ts 的 cwd 跟踪文件需要临时目录。
  const allowWrite: string[] = ['.', getZyTempDir()]
  const denyWrite: string[] = []
  const denyRead: string[] = []
  const allowRead: string[] = []

  // 始终禁止写入 settings.json，防止 sandbox 逃逸。这会阻止写入 ZY Code 启动时
  // 原始工作目录中的设置。
  const settingsPaths = SETTING_SOURCES.map((source) =>
    getSettingsFilePathForSource(source),
  ).filter((p): p is string => p !== undefined)
  denyWrite.push(...settingsPaths)
  denyWrite.push(getManagedSettingsDropInDir())

  // 当前工作目录与原始目录不同时，也阻止其中的设置文件，以处理用户 cd 到其他目录的情况。
  const cwd = getCwdState()
  const originalCwd = getOriginalCwd()
  if (cwd !== originalCwd) {
    denyWrite.push(resolve(cwd, '.zy', 'settings.json'))
    denyWrite.push(resolve(cwd, '.zy', 'settings.local.json'))
  }

  // 阻止写入原始与当前工作目录中的 .zy/skills。sandbox-runtime 的
  // getDangerousDirectories() 会保护 .zy/commands 和 .zy/agents，但不保护
  // .zy/skills。skill 具有相同权限等级（自动发现、自动加载、完整 Zy 能力），
  // 因此需要同等 OS 层 sandbox 保护。
  denyWrite.push(resolve(originalCwd, '.zy', 'skills'))
  if (cwd !== originalCwd) {
    denyWrite.push(resolve(cwd, '.zy', 'skills'))
  }

  // 安全：Git 的 is_git_directory() 会在 cwd 含以下内容时将其视为 bare repo：
  // HEAD + objects/ + refs/。攻击者植入这些内容和带 core.fsmonitor 的配置后，
  // 可在 Zy 未 sandbox 的 git 运行时逃逸。
  //
  // 无条件拒绝这些路径会使 sandbox-runtime 在不存在的位置挂载
  // /dev/null 到不存在的位置，这会在 host 留下 0 字节 HEAD stub，且使 bwrap 内的
  // `git log HEAD` 报 "ambiguous argument"。
  // 因此：文件存在时 denyWrite（原位 ro-bind，不产生 stub）；不存在时在命令后由
  // scrubBareGitRepoFiles() 清除。未 sandbox 的 git 运行前，植入文件已删除；
  // 命令内部的 git 本身处于 sandbox 中。
  bareGitRepoScrubPaths.length = 0
  const bareGitRepoFiles = ['HEAD', 'objects', 'refs', 'hooks', 'config']
  for (const dir of cwd === originalCwd ? [originalCwd] : [originalCwd, cwd]) {
    for (const gitFile of bareGitRepoFiles) {
      const p = resolve(dir, gitFile)
      try {
        // eslint-disable-next-line custom-rules/no-sync-fs -- refreshConfig() must be sync
        statSync(p)
        denyWrite.push(p)
      } catch {
        bareGitRepoScrubPaths.push(p)
      }
    }
  }

  // initialize() 检测到 git worktree 时，将主仓库路径缓存到 worktreeMainRepoPath。
  // worktree 中的 Git 操作需要写入主仓库 .git 目录，如 index.lock。
  // 该路径仅在 init 时解析一次，因为会话中途 worktree 状态不会变化。
  if (worktreeMainRepoPath && worktreeMainRepoPath !== cwd) {
    allowWrite.push(worktreeMainRepoPath)
  }

  // 包含通过 --add-dir CLI flag 或 /add-dir 命令添加的目录。这些目录必须加入
  // allowWrite，才能让 sandbox 内运行的 Bash 命令访问；不能只依赖在应用层通过
  // pathInAllowedWorkingPath() 检查权限的文件 tool。来源有两个：持久化设置，
  // 以及 bootstrap state 中的仅会话设置。
  const additionalDirs = new Set([
    ...(settings.permissions?.additionalDirectories || []),
    ...getAdditionalDirectoriesForAgentsMd(),
  ])
  allowWrite.push(...additionalDirs)

  // 遍历各设置来源以正确解析路径。`/foo` 等路径模式相对于设置文件目录，
  // 因此需要知道每条规则所属来源。
  for (const source of SETTING_SOURCES) {
    const sourceSettings = getSettingsForSource(source)

    // 从权限规则提取文件系统路径。
    if (sourceSettings?.permissions) {
      for (const ruleString of sourceSettings.permissions.allow || []) {
        const rule = permissionRuleValueFromString(ruleString)
        if (rule.toolName === FILE_EDIT_TOOL_NAME && rule.ruleContent) {
          allowWrite.push(resolvePathPatternForSandbox(rule.ruleContent, source))
        }
      }

      for (const ruleString of sourceSettings.permissions.deny || []) {
        const rule = permissionRuleValueFromString(ruleString)
        if (rule.toolName === FILE_EDIT_TOOL_NAME && rule.ruleContent) {
          denyWrite.push(resolvePathPatternForSandbox(rule.ruleContent, source))
        }
        if (rule.toolName === FILE_READ_TOOL_NAME && rule.ruleContent) {
          denyRead.push(resolvePathPatternForSandbox(rule.ruleContent, source))
        }
      }
    }

    // 从 sandbox.filesystem 设置提取文件系统路径。sandbox.filesystem.* 使用标准
    // 路径语义（/path 为绝对路径），而非权限规则约定（/path 相对于设置目录）。#30067
    const fs = sourceSettings?.sandbox?.filesystem
    if (fs) {
      for (const p of fs.allowWrite || []) {
        allowWrite.push(resolveSandboxFilesystemPath(p, source))
      }
      for (const p of fs.denyWrite || []) {
        denyWrite.push(resolveSandboxFilesystemPath(p, source))
      }
      for (const p of fs.denyRead || []) {
        denyRead.push(resolveSandboxFilesystemPath(p, source))
      }
      if (!shouldAllowManagedReadPathsOnly() || source === 'policySettings') {
        for (const p of fs.allowRead || []) {
          allowRead.push(resolveSandboxFilesystemPath(p, source))
        }
      }
    }
  }
  // 沙箱 ripgrep 配置：优先用用户设置，否则使用 @vscode/ripgrep 内置二进制
  const { rgPath, rgArgs } = ripgrepCommand()
  const ripgrepConfig = settings.sandbox?.ripgrep ?? {
    command: rgPath,
    args: rgArgs,
  }

  return {
    network: {
      allowedDomains,
      deniedDomains,
      allowUnixSockets: settings.sandbox?.network?.allowUnixSockets,
      allowAllUnixSockets: settings.sandbox?.network?.allowAllUnixSockets,
      allowLocalBinding: settings.sandbox?.network?.allowLocalBinding,
      httpProxyPort: settings.sandbox?.network?.httpProxyPort,
      socksProxyPort: settings.sandbox?.network?.socksProxyPort,
    },
    filesystem: {
      denyRead,
      allowRead,
      allowWrite,
      denyWrite,
    },
    ignoreViolations: settings.sandbox?.ignoreViolations,
    enableWeakerNestedSandbox: settings.sandbox?.enableWeakerNestedSandbox,
    enableWeakerNetworkIsolation: settings.sandbox?.enableWeakerNetworkIsolation,
    ripgrep: ripgrepConfig,
  }
}

// ============================================================================
// Zy CLI 特有状态。
// ============================================================================

let initializationPromise: Promise<void> | undefined
let settingsSubscriptionCleanup: (() => void) | undefined

// git worktree 的主仓库路径缓存，在 initialize() 期间解析一次。worktree 中 .git
// 是包含 "gitdir: /path/to/main/repo/.git/worktrees/name" 的文件。
// undefined 表示尚未解析；null 表示不是 worktree 或检测失败。
let worktreeMainRepoPath: string | null | undefined

// 配置时 cwd 中不存在、但在 sandbox 命令后出现时应清除的 bare-repo 文件。
// 参见 anthropics/zy-code#29316。
let bareGitRepoScrubPaths: string[]
bareGitRepoScrubPaths = []

/**
 * 在 Zy 未 sandbox 的 git 调用看到之前，删除 sandbox 命令期间植入 cwd 的
 * bare-repo 文件。参见上方安全说明。
 * bareGitRepoFiles. anthropics/zy-code#29316.
 */
function scrubBareGitRepoFiles(): void {
  for (const p of bareGitRepoScrubPaths) {
    try {
      // eslint-disable-next-line custom-rules/no-sync-fs -- cleanupAfterCommand must be sync (Shell.ts:367)
      rmSync(p, { recursive: true })
      logForDebugging(`[Sandbox] scrubbed planted bare-repo file: ${p}`)
    } catch {
      // ENOENT 是预期的常见情况，表示没有植入文件。
    }
  }
}

/**
 * 检测 cwd 是否为 git worktree，并解析主仓库路径。initialize() 期间调用一次，
 * 结果在会话内缓存。worktree 中 .git 是包含 "gitdir: ..." 的文件，而非目录；
 * 若 .git 是目录，readFile 会抛出 EISDIR，此时返回 null。
 */
async function detectWorktreeMainRepoPath(cwd: string): Promise<string | null> {
  const gitPath = join(cwd, '.git')
  try {
    const gitContent = await readFile(gitPath, { encoding: 'utf8' })
    const gitdirMatch = gitContent.match(/^gitdir:\s*(.+)$/m)
    if (!gitdirMatch?.[1]) {
      return null
    }
    // gitdir 可能是相对路径，虽少见但 git 接受；此时相对于 cwd 解析。
    const gitdir = resolve(cwd, gitdirMatch[1].trim())
    // gitdir 格式：/path/to/main/repo/.git/worktrees/worktree-name。
    // 必须明确匹配 /.git/worktrees/ 段；只用 indexOf('.git') 会误匹配
    // /home/user/.github-projects/... 等路径。
    const marker = `${sep}.git${sep}worktrees${sep}`
    const markerIndex = gitdir.lastIndexOf(marker)
    if (markerIndex > 0) {
      return gitdir.substring(0, markerIndex)
    }
    return null
  } catch {
    // 不在 worktree 中、.git 是目录（EISDIR），或无法读取 .git 文件。
    return null
  }
}

/**
 * 检查依赖是否可用（memoized）。返回 { errors, warnings }；errors 表示 sandbox 无法运行。
 */
const checkDependencies = memoize((): SandboxDependencyCheck => {
  const { rgPath, rgArgs } = ripgrepCommand()
  return BaseSandboxManager.checkDependencies({
    command: rgPath,
    args: rgArgs,
  })
})

function getSandboxEnabledSetting(): boolean {
  try {
    const settings = getInitialSettings()
    return settings?.sandbox?.enabled ?? false
  } catch (error) {
    logForDebugging(`Failed to get settings for sandbox check: ${error}`)
    return false
  }
}

function isAutoAllowBashIfSandboxedEnabled(): boolean {
  const settings = getInitialSettings()
  return settings?.sandbox?.autoAllowBashIfSandboxed ?? true
}

function areUnsandboxedCommandsAllowed(): boolean {
  const settings = getInitialSettings()
  return settings?.sandbox?.allowUnsandboxedCommands ?? true
}

function isSandboxRequired(): boolean {
  const settings = getInitialSettings()
  return getSandboxEnabledSetting() && (settings?.sandbox?.failIfUnavailable ?? false)
}

/**
 * 检查当前平台是否支持 sandbox（memoized）。支持 macOS、Linux、WSL2+，不支持 WSL1。
 */
const isSupportedPlatform = memoize((): boolean => {
  return BaseSandboxManager.isSupportedPlatform()
})

/**
 * 检查当前平台是否在 enabledPlatforms 列表中。
 *
 * 这是未公开设置，用于将 sandbox 限制到特定平台。未设置 enabledPlatforms 时，
 * 允许所有受支持平台。
 *
 * 为解除 NVIDIA 企业推广阻塞而加入：由于 Linux/WSL sandbox 支持较新，他们希望
 * 初期只在 macOS 启用 autoAllowBashIfSandboxed。设置 enabledPlatforms: ["macos"]
 * 可在其他平台禁用 sandbox 及自动允许。
 */
function isPlatformInEnabledList(): boolean {
  try {
    const settings = getInitialSettings()
    const enabledPlatforms = (settings?.sandbox as { enabledPlatforms?: Platform[] } | undefined)
      ?.enabledPlatforms

    if (enabledPlatforms === undefined) {
      return true
    }

    if (enabledPlatforms.length === 0) {
      return false
    }

    const currentPlatform = getPlatform()
    return enabledPlatforms.includes(currentPlatform)
  } catch (error) {
    logForDebugging(`Failed to check enabledPlatforms: ${error}`)
    return true // Default to enabled if we can't read settings
  }
}

/**
 * 检查 sandbox 是否启用，包括用户 enabled 设置、平台支持和 enabledPlatforms 限制。
 */
function isSandboxingEnabled(): boolean {
  if (!isSupportedPlatform()) {
    return false
  }

  if (checkDependencies().errors.length > 0) {
    return false
  }

  // 检查当前平台是否在 enabledPlatforms 列表中；这是未公开设置。
  if (!isPlatformInEnabledList()) {
    return false
  }

  return getSandboxEnabledSetting()
}

/**
 * 用户显式启用 sandbox（设置中 sandbox.enabled: true）但实际无法运行时，
 * 返回可读原因；否则返回 undefined。
 *
 * 修复 #34044：此前依赖缺失时 isSandboxingEnabled() 静默返回 false，用户完全
 * 不知道显式安全设置已被忽略。这是安全陷阱：用户配置 allowedDomains 并期待强制
 * 执行，实际却没有任何限制。
 *
 * 启动时（REPL/print）调用一次，并在有原因时展示。用户从未启用 sandbox 时不处理，
 * 避免噪声。
 */
function getSandboxUnavailableReason(): string | undefined {
  // 仅在用户显式要求 sandbox 时警告；未启用时，缺失依赖无关紧要。
  if (!getSandboxEnabledSetting()) {
    return undefined
  }

  if (!isSupportedPlatform()) {
    const platform = getPlatform()
    if (platform === 'wsl') {
      return 'sandbox.enabled is set but WSL1 is not supported (requires WSL2)'
    }
    return `sandbox.enabled is set but ${platform} is not supported (requires macOS, Linux, or WSL2)`
  }

  if (!isPlatformInEnabledList()) {
    return `sandbox.enabled is set but ${getPlatform()} is not in sandbox.enabledPlatforms`
  }

  const deps = checkDependencies()
  if (deps.errors.length > 0) {
    const platform = getPlatform()
    const hint =
      platform === 'macos'
        ? 'run /sandbox or /doctor for details'
        : 'install missing tools (e.g. apt install bubblewrap socat) or run /sandbox for details'
    return `sandbox.enabled is set but dependencies are missing: ${deps.errors.join(', ')} · ${hint}`
  }

  return undefined
}

/**
 * 获取无法在 Linux/WSL 上完整工作的 glob 模式。
 */
function getLinuxGlobPatternWarnings(): string[] {
  // 仅在 Linux/WSL 返回警告，因为 bubblewrap 不支持 glob。
  const platform = getPlatform()
  if (platform !== 'linux' && platform !== 'wsl') {
    return []
  }

  try {
    const settings = getInitialSettings()

    // 仅在 sandbox 已启用时返回警告；直接检查设置，不使用缓存值。
    if (!settings?.sandbox?.enabled) {
      return []
    }

    const permissions = settings?.permissions || {}
    const warnings: string[] = []

    // 检查路径是否含 glob 字符的辅助函数，不含尾部 /**。
    const hasGlobs = (path: string): boolean => {
      const stripped = path.replace(/\/\*\*$/, '')
      return /[*?[\]]/.test(stripped)
    }

    // 检查全部权限规则。
    for (const ruleString of [...(permissions.allow || []), ...(permissions.deny || [])]) {
      const rule = permissionRuleValueFromString(ruleString)
      if (
        (rule.toolName === FILE_EDIT_TOOL_NAME || rule.toolName === FILE_READ_TOOL_NAME) &&
        rule.ruleContent &&
        hasGlobs(rule.ruleContent)
      ) {
        warnings.push(ruleString)
      }
    }

    return warnings
  } catch (error) {
    logForDebugging(`Failed to get Linux glob pattern warnings: ${error}`)
    return []
  }
}

/**
 * 检查 sandbox 设置是否被策略锁定。
 */
function areSandboxSettingsLockedByPolicy(): boolean {
  // 检查是否有覆盖 localSettings 的来源显式设置 sandbox。这些来源优先级更高，
  // 会使本地修改无效。
  const overridingSources = ['flagSettings', 'policySettings'] as const

  for (const source of overridingSources) {
    const settings = getSettingsForSource(source)
    if (
      settings?.sandbox?.enabled !== undefined ||
      settings?.sandbox?.autoAllowBashIfSandboxed !== undefined ||
      settings?.sandbox?.allowUnsandboxedCommands !== undefined
    ) {
      return true
    }
  }

  return false
}

/**
 * 设置 sandbox。
 */
async function setSandboxSettings(options: {
  enabled?: boolean
  autoAllowBashIfSandboxed?: boolean
  allowUnsandboxedCommands?: boolean
}): Promise<void> {
  const existingSettings = getSettingsForSource('localSettings')

  // 注意：memoize 缓存以 settings 对象为键，因此设置变化时会自动失效；
  // 新 settings 对象会导致缓存未命中。

  updateSettingsForSource('localSettings', {
    sandbox: {
      ...existingSettings?.sandbox,
      ...(options.enabled !== undefined && { enabled: options.enabled }),
      ...(options.autoAllowBashIfSandboxed !== undefined && {
        autoAllowBashIfSandboxed: options.autoAllowBashIfSandboxed,
      }),
      ...(options.allowUnsandboxedCommands !== undefined && {
        allowUnsandboxedCommands: options.allowUnsandboxedCommands,
      }),
    },
  })
}

/**
 * 获取不应在 sandbox 中运行的排除命令。
 */
function getExcludedCommands(): string[] {
  const settings = getInitialSettings()
  return settings?.sandbox?.excludedCommands ?? []
}

/**
 * 使用 sandbox 包装命令，并可指定要使用的 shell。
 */
async function wrapWithSandbox(
  command: string,
  binShell?: string,
  customConfig?: Partial<SandboxRuntimeConfig>,
  abortSignal?: AbortSignal,
): Promise<string> {
  // sandbox 已启用时确保初始化完成。
  if (isSandboxingEnabled()) {
    if (initializationPromise) {
      await initializationPromise
    } else {
      throw new Error('Sandbox failed to initialize. ')
    }
  }

  return BaseSandboxManager.wrapWithSandbox(command, binShell, customConfig, abortSignal)
}

/**
 * 初始化 sandbox，默认启用日志监控。
 */
async function initialize(sandboxAskCallback?: SandboxAskCallback): Promise<void> {
  // 正在初始化或已初始化时返回现有 Promise。
  if (initializationPromise) {
    return initializationPromise
  }

  // 检查设置中是否启用 sandbox。
  if (!isSandboxingEnabled()) {
    return
  }

  // 包装 callback 以强制执行 allowManagedDomainsOnly 策略，覆盖 REPL、print/SDK
  // 等全部代码路径。
  const wrappedCallback: SandboxAskCallback | undefined = sandboxAskCallback
    ? async (hostPattern: NetworkHostPattern) => {
        if (shouldAllowManagedSandboxDomainsOnly()) {
          logForDebugging(
            `[sandbox] Blocked network request to ${hostPattern.host} (allowManagedDomainsOnly)`,
          )
          return false
        }
        return sandboxAskCallback(hostPattern)
      }
    : undefined

  // 在任何 await 前同步创建初始化 Promise，避免 Promise 赋值前调用
  // wrapWithSandbox() 的竞态。
  initializationPromise = (async () => {
    try {
      // 构建配置前解析一次 worktree 主仓库路径。会话中途 worktree 状态不会变化，
      // 因此缓存供后续 refreshConfig() 调用使用；这些调用必须同步，避免待处理请求
      // 使用陈旧配置漏过检查的竞态。
      if (worktreeMainRepoPath === undefined) {
        worktreeMainRepoPath = await detectWorktreeMainRepoPath(getCwdState())
      }

      const settings = getInitialSettings()
      const runtimeConfig = convertToSandboxRuntimeConfig(settings)

      // macOS 上自动启用日志 monitor。
      await BaseSandboxManager.initialize(runtimeConfig, wrappedCallback)

      // 订阅设置变化，动态更新 sandbox 配置。
      settingsSubscriptionCleanup = settingsChangeDetector.subscribe(() => {
        const settings = getInitialSettings()
        const newConfig = convertToSandboxRuntimeConfig(settings)
        BaseSandboxManager.updateConfig(newConfig)
        logForDebugging('Sandbox configuration updated from settings change')
      })
    } catch (error) {
      // 出错时清空 Promise，以便重试初始化。
      initializationPromise = undefined

      // 记录错误但不抛出，让 sandbox 平稳失败。
      logForDebugging(`Failed to initialize sandbox: ${errorMessage(error)}`)
    }
  })()

  return initializationPromise
}

/**
 * 立即根据当前设置刷新 sandbox 配置。更新权限后调用，以避免竞态。
 */
function refreshConfig(): void {
  if (!isSandboxingEnabled()) {
    return
  }
  const settings = getInitialSettings()
  const newConfig = convertToSandboxRuntimeConfig(settings)
  BaseSandboxManager.updateConfig(newConfig)
}

/**
 * 重置 sandbox 状态并清除 memoize 值。
 */
async function reset(): Promise<void> {
  // 清理设置订阅。
  settingsSubscriptionCleanup?.()
  settingsSubscriptionCleanup = undefined
  worktreeMainRepoPath = undefined
  bareGitRepoScrubPaths.length = 0

  // 清除 memoize 缓存。
  checkDependencies.cache.clear?.()
  isSupportedPlatform.cache.clear?.()
  initializationPromise = undefined

  // 重置基础 sandbox manager。
  return BaseSandboxManager.reset()
}

/**
 * 将命令加入排除列表，使其不在 sandbox 中运行。这是更新本地设置的 Zy CLI 特有函数。
 */
export function addToExcludedCommands(
  command: string,
  permissionUpdates?: Array<{
    type: string
    rules: Array<{ toolName: string; ruleContent?: string }>
  }>,
): string {
  const existingSettings = getSettingsForSource('localSettings')
  const existingExcludedCommands = existingSettings?.sandbox?.excludedCommands || []

  // 确定要添加的命令模式。有带 Bash 规则的 suggestion 时提取模式，例如从
  // "npm run test:*" 提取 "npm run test"；否则使用精确命令。
  let commandPattern: string = command

  if (permissionUpdates) {
    const bashSuggestions = permissionUpdates.filter(
      (update) =>
        update.type === 'addRules' && update.rules.some((rule) => rule.toolName === BASH_TOOL_NAME),
    )

    if (bashSuggestions.length > 0 && bashSuggestions[0]!.type === 'addRules') {
      const firstBashRule = bashSuggestions[0]!.rules.find(
        (rule) => rule.toolName === BASH_TOOL_NAME,
      )
      if (firstBashRule?.ruleContent) {
        // 从 Bash(command) 或 Bash(command:*) 格式提取模式。
        const prefix = permissionRuleExtractPrefix(firstBashRule.ruleContent)
        commandPattern = prefix || firstBashRule.ruleContent
      }
    }
  }

  // 尚不存在时加入 excludedCommands。
  if (!existingExcludedCommands.includes(commandPattern)) {
    updateSettingsForSource('localSettings', {
      sandbox: {
        ...existingSettings?.sandbox,
        excludedCommands: [...existingExcludedCommands, commandPattern],
      },
    })
  }

  return commandPattern
}

// ============================================================================
// 导出接口和实现。
// ============================================================================

export interface ISandboxManager {
  initialize(sandboxAskCallback?: SandboxAskCallback): Promise<void>
  isSupportedPlatform(): boolean
  isPlatformInEnabledList(): boolean
  getSandboxUnavailableReason(): string | undefined
  isSandboxingEnabled(): boolean
  isSandboxEnabledInSettings(): boolean
  checkDependencies(): SandboxDependencyCheck
  isAutoAllowBashIfSandboxedEnabled(): boolean
  areUnsandboxedCommandsAllowed(): boolean
  isSandboxRequired(): boolean
  areSandboxSettingsLockedByPolicy(): boolean
  setSandboxSettings(options: {
    enabled?: boolean
    autoAllowBashIfSandboxed?: boolean
    allowUnsandboxedCommands?: boolean
  }): Promise<void>
  getFsReadConfig(): FsReadRestrictionConfig
  getFsWriteConfig(): FsWriteRestrictionConfig
  getNetworkRestrictionConfig(): NetworkRestrictionConfig
  getAllowUnixSockets(): string[] | undefined
  getAllowLocalBinding(): boolean | undefined
  getIgnoreViolations(): IgnoreViolationsConfig | undefined
  getEnableWeakerNestedSandbox(): boolean | undefined
  getExcludedCommands(): string[]
  getProxyPort(): number | undefined
  getSocksProxyPort(): number | undefined
  getLinuxHttpSocketPath(): string | undefined
  getLinuxSocksSocketPath(): string | undefined
  waitForNetworkInitialization(): Promise<boolean>
  wrapWithSandbox(
    command: string,
    binShell?: string,
    customConfig?: Partial<SandboxRuntimeConfig>,
    abortSignal?: AbortSignal,
  ): Promise<string>
  cleanupAfterCommand(): void
  getSandboxViolationStore(): SandboxViolationStore
  annotateStderrWithSandboxFailures(command: string, stderr: string): string
  getLinuxGlobPatternWarnings(): string[]
  refreshConfig(): void
  reset(): Promise<void>
}

/**
 * Zy CLI sandbox manager：在 sandbox-runtime 外封装 Zy 特有功能。
 */
export const SandboxManager: ISandboxManager = {
  // 自定义实现。
  initialize,
  isSandboxingEnabled,
  isSandboxEnabledInSettings: getSandboxEnabledSetting,
  isPlatformInEnabledList,
  getSandboxUnavailableReason,
  isAutoAllowBashIfSandboxedEnabled,
  areUnsandboxedCommandsAllowed,
  isSandboxRequired,
  areSandboxSettingsLockedByPolicy,
  setSandboxSettings,
  getExcludedCommands,
  wrapWithSandbox,
  refreshConfig,
  reset,
  checkDependencies,

  // 转发到基础 sandbox manager。
  getFsReadConfig: BaseSandboxManager.getFsReadConfig,
  getFsWriteConfig: BaseSandboxManager.getFsWriteConfig,
  getNetworkRestrictionConfig: BaseSandboxManager.getNetworkRestrictionConfig,
  getIgnoreViolations: BaseSandboxManager.getIgnoreViolations,
  getLinuxGlobPatternWarnings,
  isSupportedPlatform,
  getAllowUnixSockets: BaseSandboxManager.getAllowUnixSockets,
  getAllowLocalBinding: BaseSandboxManager.getAllowLocalBinding,
  getEnableWeakerNestedSandbox: BaseSandboxManager.getEnableWeakerNestedSandbox,
  getProxyPort: BaseSandboxManager.getProxyPort,
  getSocksProxyPort: BaseSandboxManager.getSocksProxyPort,
  getLinuxHttpSocketPath: BaseSandboxManager.getLinuxHttpSocketPath,
  getLinuxSocksSocketPath: BaseSandboxManager.getLinuxSocksSocketPath,
  waitForNetworkInitialization: BaseSandboxManager.waitForNetworkInitialization,
  getSandboxViolationStore: BaseSandboxManager.getSandboxViolationStore,
  annotateStderrWithSandboxFailures: BaseSandboxManager.annotateStderrWithSandboxFailures,
  cleanupAfterCommand: (): void => {
    BaseSandboxManager.cleanupAfterCommand()
    scrubBareGitRepoFiles()
  },
}

// ============================================================================
// 从 sandbox-runtime 重新导出类型。
// ============================================================================

export type {
  FsReadRestrictionConfig,
  FsWriteRestrictionConfig,
  IgnoreViolationsConfig,
  NetworkHostPattern,
  NetworkRestrictionConfig,
  SandboxAskCallback,
  SandboxDependencyCheck,
  SandboxRuntimeConfig,
  SandboxViolationEvent,
}

export { SandboxRuntimeConfigSchema, SandboxViolationStore }
