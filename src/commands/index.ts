// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { tSync } from '../i18n/index.js'
import { COMMAND_DESCRIPTION_I18N_KEYS } from '../commands/descriptionI18n.js'
import { isBgSession } from '../utils/concurrentSessions.js'
import { isInternalBuild } from '../utils/envUtils.js'
import addDir from '../commands/add-dir/index.js'
import background from 'src/commands/background/index.js'
import goal from '../commands/goal/index.js'
import powerup from '../commands/powerup/index.js'
import autofixPr from '../commands/autofix-pr/index.js'
import backfillSessions from '../commands/backfill-sessions/index.js'
import btw from '../commands/btw/index.js'
import issue from '../commands/issue/index.js'
import feedback from '../commands/feedback/index.js'
import clear from '../commands/clear/index.js'
import color from '../commands/color/index.js'
import commit from '../commands/commit.js'
import copy from '../commands/copy/index.js'
import desktop from '../commands/desktop/index.js'
import commitPushPr from '../commands/commit-push-pr.js'
import compact from '../commands/compact/index.js'
import config from '../commands/config/index.js'
import { context, contextNonInteractive } from '../commands/context/index.js'
// /cost 已合并为 /usage 的别名，不再独立注册
import diff from '../commands/diff/index.js'
import ctx_viz from '../commands/ctx-viz/index.js'
import doctor from '../commands/doctor/index.js'
import memory from '../commands/memory/index.js'
import help from '../commands/help/index.js'
import ide from '../commands/ide/index.js'
import init from '../commands/init.js'
import initVerifiers from '../commands/init-verifiers.js'
import keybindings from '../commands/keybindings/index.js'
import login from '../commands/login/index.js'
import logout from '../commands/logout/index.js'
import installGitHubApp from '../commands/install-github-app/index.js'
import installSlackApp from '../commands/install-slack-app/index.js'
import breakCache from '../commands/break-cache/index.js'
import mcp from '../commands/mcp/index.js'
import mobile from '../commands/mobile/index.js'
import onboarding from '../commands/onboarding/index.js'
import pr_comments from '../commands/pr-comments/index.js'
import releaseNotes from '../commands/release-notes/index.js'
import rename, { renameLocal } from '../commands/rename/index.js'
import resume from '../commands/resume/index.js'
import { ultrareview } from '../commands/review.js'
import session from '../commands/session/index.js'
import share from '../commands/share/index.js'
import skills from '../commands/skills/index.js'
import status from '../commands/status/index.js'
import tasks from '../commands/tasks/index.js'
import teleport from '../commands/teleport/index.js'
import tools from '../commands/tools/index.js'
import bughunter from '../commands/bughunter/index.js'
import terminalSetup from '../commands/terminal-setup/index.js'
import tui from '../commands/tui/index.js'
import usage from '../commands/usage/index.js'
import theme from '../commands/theme/index.js'
import vim from '../commands/vim/index.js'
import { feature } from 'bun:bundle'
/* eslint-enable @typescript-eslint/no-require-imports */
import thinkback from '../commands/thinkback/index.js'
import thinkbackPlay from '../commands/thinkback-play/index.js'
import permissions from '../commands/permissions/index.js'
import plan from '../commands/plan/index.js'
import hooks from '../commands/hooks/index.js'
import files from '../commands/files/index.js'
import branch from '../commands/branch/index.js'
import codeReview from '../commands/code-review/index.js'
import agents from '../commands/agents/index.js'
import plugin from '../commands/plugin/index.js'
import reloadPlugins from '../commands/reload-plugins/index.js'
import reloadSkills from '../commands/reload-skills/index.js'
import reloadTools from '../commands/reload-tools/index.js'
import rewind from '../commands/rewind/index.js'
import heapDump from '../commands/heapdump/index.js'
import mockLimits from '../commands/mock-limits/index.js'
import bridgeKick from '../commands/bridge-kick.js'
import version from '../commands/version.js'
import summary from '../commands/summary/index.js'
import { resetLimits, resetLimitsNonInteractive } from '../commands/reset-limits/index.js'
import antTrace from '../commands/ant-trace/index.js'
import perfIssue from '../commands/perf-issue/index.js'
import sandboxToggle from '../commands/sandbox-toggle/index.js'
import chrome from '../commands/chrome/index.js'
import stickers from '../commands/stickers/index.js'
import { logError } from '../utils/log.js'
import { toError } from '../utils/errors.js'
import { logForDebugging } from '../utils/debug.js'
import { clearSkillCaches, getDynamicSkills, getSkillDirCommands } from '../skills/loadSkillsDir.js'
import { getBundledSkills } from '../skills/bundledSkills.js'
import { getBuiltinPluginSkillCommands } from '../services/plugins/builtinRegistry.js'
import {
  clearPluginCommandCache,
  clearPluginSkillsCache,
  getPluginCommands,
  getPluginSkills,
} from '../services/plugins/loadPluginCommands.js'
import memoize from 'lodash-es/memoize.js'

import { isAnthropicBaseUrl } from '../services/model/providers.js'
import env from '../commands/env/index.js'
import exit from '../commands/exit/index.js'
import exportCommand from '../commands/export/index.js'
import model, { modelLocal } from '../commands/model/index.js'
import tag from '../commands/tag/index.js'
import outputStyle from '../commands/output-style/index.js'
import remoteEnv from '../commands/remote-env/index.js'
import upgrade from '../commands/upgrade/index.js'
import rateLimitOptions from '../commands/rate-limit-options/index.js'
import statusline from '../commands/statusline/index.js'
import effort, { effortLocal } from '../commands/effort/index.js'
import oauthRefresh from '../commands/oauth-refresh/index.js'
import debugToolCall from '../commands/debug-tool-call/index.js'
import { getSettingSourceName } from '../services/settings/constants.js'
import { type Command, getCommandName, isCommandEnabled } from '../commands/types.js'
// 死代码消除：条件导入
/* eslint-disable @typescript-eslint/no-require-imports */
let proactive: Command | null = null
if (feature('PROACTIVE')) {
  proactive = require('../commands/proactive.js').default as Command
} else if (feature('KAIROS')) {
  proactive = require('../commands/proactive.js').default as Command
}

let briefCommand: Command | null = null
if (feature('KAIROS')) {
  briefCommand = require('../commands/brief.js').default as Command
} else if (feature('KAIROS_BRIEF')) {
  briefCommand = require('../commands/brief.js').default as Command
}

const assistantCommand = feature('KAIROS') ? require('../commands/assistant/index.js').default : null
const bridge = feature('BRIDGE_MODE') ? require('../commands/bridge/index.js').default : null
let remoteControlServerCommand: Command | null = null
if (feature('DAEMON')) {
  if (feature('BRIDGE_MODE')) {
    remoteControlServerCommand = require('../commands/remoteControlServer/index.js')
      .default as Command
  }
}
const voiceCommand = feature('VOICE_MODE') ? require('../commands/voice/index.js').default : null
const workflowsCmd = feature('WORKFLOW_SCRIPTS')
  ? (require('../commands/workflows/index.js') as typeof import('../commands/workflows/index.js'))
      .default
  : null
const webCmd = feature('CCR_REMOTE_SETUP')
  ? (
      require('../commands/remote-setup/index.js') as typeof import('../commands/remote-setup/index.js')
    ).default
  : null
const clearSkillIndexCache = feature('EXPERIMENTAL_SKILL_SEARCH')
  ? (
      require('../services/skill-search/localSearch.js') as typeof import('../services/skill-search/localSearch.js')
    ).clearSkillIndexCache
  : null
const subscribePr = feature('KAIROS_GITHUB_WEBHOOKS')
  ? require('../commands/subscribe-pr.js').default
  : null
const ultraplan = feature('ULTRAPLAN') ? require('../commands/ultraplan.js').default : null
const torch = feature('TORCH') ? require('../commands/torch.js').default : null
const peersCmd = feature('UDS_INBOX')
  ? (require('../commands/peers/index.js') as typeof import('../commands/peers/index.js')).default
  : null
const forkCmd = feature('FORK_SUBAGENT')
  ? (require('../commands/fork/index.js') as typeof import('../commands/fork/index.js')).default
  : null

// /stats 已合并为 /usage 的别名（通过 invokedAs 跳转到 Stats tab）
// insights.ts 文件为 113KB（3200 行，包含 diffLines/html 渲染）。懒加载垫片将重型模块延迟到 /insights 实际被调用时才加载。
const usageReport: Command = {
  type: 'prompt',
  name: 'insights',
  description: 'Generate a report analyzing your ZY Code sessions',
  contentLength: 0,
  progressMessage: 'analyzing your sessions',
  source: 'builtin',
  async getPromptForCommand(args, context) {
    const real = (await import('../commands/insights.js')).default
    if (real.type !== 'prompt') {
      throw new Error('unreachable')
    }
    return real.getPromptForCommand(args, context)
  },
}

// 从集中位置重新导出类型
export type {
  Command,
  CommandBase,
  CommandResultDisplay,
  LocalCommandResult,
  LocalJSXCommandContext,
  PromptCommand,
  ResumeEntrypoint,
} from '../commands/types.js'
export { getCommandName, isCommandEnabled } from '../commands/types.js'

// 在外部构建中会被移除的命令
export const INTERNAL_ONLY_COMMANDS = [
  backfillSessions,
  breakCache,
  bughunter,
  commit,
  commitPushPr,
  ctx_viz,
  issue,
  initVerifiers,
  mockLimits,
  bridgeKick,
  version,
  ...(ultraplan ? [ultraplan] : []),
  ...(subscribePr ? [subscribePr] : []),
  resetLimits,
  resetLimitsNonInteractive,
  onboarding,
  share,
  summary,
  teleport,
  antTrace,
  perfIssue,
  env,
  oauthRefresh,
  debugToolCall,
  autofixPr,
].filter(Boolean)

// 声明为函数而不是常量，这样只有 getCommands 被调用时才会执行
// 因为底层函数会读取配置，而配置在模块初始化时还不可用
const COMMANDS = memoize((): Command[] => [
  addDir,
  agents,
  background,
  branch,
  btw,
  chrome,
  clear,
  codeReview,
  color,
  compact,
  config,
  copy,
  desktop,
  context,
  contextNonInteractive,
  diff,
  doctor,
  effort,
  // 同名 local 变体：交互模式 findCommand 命中前者，非交互过滤后只剩本项
  effortLocal,
  exit,
  files,
  goal,
  heapDump,
  help,
  ide,
  init,
  keybindings,
  installGitHubApp,
  installSlackApp,
  mcp,
  memory,
  mobile,
  model,
  // 同名 local 变体：交互模式 findCommand 命中前者，非交互过滤后只剩本项
  modelLocal,
  outputStyle,
  remoteEnv,
  plugin,
  powerup,
  pr_comments,
  releaseNotes,
  reloadPlugins,
  reloadSkills,
  reloadTools,
  rename,
  // 同名 local 变体：仅在非交互过滤后生效（交互模式 findCommand 命中紧靠在前的 rename）
  renameLocal,
  resume,
  session,
  skills,
  status,
  statusline,
  stickers,
  tag,
  theme,
  tools,
  feedback,
  ultrareview,
  rewind,
  terminalSetup,
  upgrade,
  rateLimitOptions,
  tui,
  usage,
  usageReport,
  vim,
  ...(webCmd ? [webCmd] : []),
  ...(forkCmd ? [forkCmd] : []),
  ...(proactive ? [proactive] : []),
  ...(briefCommand ? [briefCommand] : []),
  ...(assistantCommand ? [assistantCommand] : []),
  ...(bridge ? [bridge] : []),
  ...(remoteControlServerCommand ? [remoteControlServerCommand] : []),
  ...(voiceCommand ? [voiceCommand] : []),
  thinkback,
  thinkbackPlay,
  permissions,
  plan,
  hooks,
  exportCommand,
  sandboxToggle,
  ...[logout, login()],
  ...(peersCmd ? [peersCmd] : []),
  tasks,
  ...(workflowsCmd ? [workflowsCmd] : []),
  ...(torch ? [torch] : []),
  ...(isInternalBuild() && !process.env.IS_DEMO ? INTERNAL_ONLY_COMMANDS : []),
])

export const builtInCommandNames = memoize(
  (): Set<string> => new Set(COMMANDS().flatMap((_) => [_.name, ...(_.aliases ?? [])])),
)

async function getSkills(cwd: string): Promise<{
  skillDirCommands: Command[]
  pluginSkills: Command[]
  bundledSkills: Command[]
  builtinPluginSkills: Command[]
}> {
  try {
    const [skillDirCommands, pluginSkills] = await Promise.all([
      getSkillDirCommands(cwd).catch((err) => {
        logError(toError(err))
        logForDebugging('Skill directory commands failed to load, continuing without them')
        return []
      }),
      getPluginSkills().catch((err) => {
        logError(toError(err))
        logForDebugging('Plugin skills failed to load, continuing without them')
        return []
      }),
    ])
    // 预置技能在启动时同步注册
    const bundledSkills = getBundledSkills()
    // 内置插件技能来自已启用的内置插件
    const builtinPluginSkills = getBuiltinPluginSkillCommands()
    logForDebugging(
      `getSkills returning: ${skillDirCommands.length} skill dir commands, ${pluginSkills.length} plugin skills, ${bundledSkills.length} bundled skills, ${builtinPluginSkills.length} builtin plugin skills`,
    )
    return {
      skillDirCommands,
      pluginSkills,
      bundledSkills,
      builtinPluginSkills,
    }
  } catch (err) {
    // 由于在 Promise 层面做了 catch，这里理论上不应该发生，但做防御性处理
    logError(toError(err))
    logForDebugging('Unexpected error in getSkills, returning empty')
    return {
      skillDirCommands: [],
      pluginSkills: [],
      bundledSkills: [],
      builtinPluginSkills: [],
    }
  }
}

/* eslint-disable @typescript-eslint/no-require-imports */
const getWorkflowCommands = feature('WORKFLOW_SCRIPTS')
  ? (
      require('../tools/WorkflowTool/createWorkflowCommand.js') as typeof import('../tools/WorkflowTool/createWorkflowCommand.js')
    ).getWorkflowCommands
  : null
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * Filters commands by their declared `availability` (auth/provider requirement).
 * Commands without `availability` are treated as universal.
 * This runs before `isEnabled()` so that provider-gated commands are hidden
 * regardless of feature-flag state.
 *
 * 不使用 memoize — 认证状态可能在会话中途改变（例如 /login 之后），
 * 因此每次 getCommands() 调用都必须重新评估。
 */
export function meetsAvailabilityRequirement(cmd: Command): boolean {
  if (!cmd.availability) {
    return true
  }
  for (const a of cmd.availability) {
    switch (a) {
      case 'zy-ai':
        return false
      case 'console':
        // Console API key user = direct API customer (not 3P, not zy.ai).
        // Excludes 3P (Bedrock/Vertex/Foundry) who don't set ZY_CODE_BASE_URL
        // and gateway users who proxy through a custom base URL.
        return true
      default: {
        // 编译期检查，避免上述case存在遗漏
        const _exhaustive: never = a
        void _exhaustive
        break
      }
    }
  }
  return false
}

/**
 * Loads all command sources (skills, plugins, workflows). Memoized by cwd
 * because loading is expensive (disk I/O, dynamic imports).
 */
const loadAllCommands = memoize(async (cwd: string): Promise<Command[]> => {
  const [
    { skillDirCommands, pluginSkills, bundledSkills, builtinPluginSkills },
    pluginCommands,
    workflowCommands,
  ] = await Promise.all([
    getSkills(cwd),
    getPluginCommands(),
    getWorkflowCommands ? getWorkflowCommands() : Promise.resolve([]),
  ])

  return [
    ...bundledSkills,
    ...builtinPluginSkills,
    ...skillDirCommands,
    ...workflowCommands,
    ...pluginCommands,
    ...pluginSkills,
    ...COMMANDS(),
  ]
})

/**
 * Returns commands available to the current user. The expensive loading is
 * memoized, but availability and isEnabled checks run fresh every call so
 * auth changes (e.g. /login) take effect immediately.
 */
export async function getCommands(cwd: string): Promise<Command[]> {
  const allCommands = await loadAllCommands(cwd)

  // 获取在文件操作期间发现的动态技能
  const dynamicSkills = getDynamicSkills()

  // 构建不包含动态技能的基础命令列表
  const baseCommands = allCommands.filter(
    (_) => meetsAvailabilityRequirement(_) && isCommandEnabled(_),
  )

  if (dynamicSkills.length === 0) {
    return baseCommands
  }

  // 对动态技能去重 — 仅当尚未存在时才添加
  const baseCommandNames = new Set(baseCommands.map((c) => c.name))
  const uniqueDynamicSkills = dynamicSkills.filter(
    (s) => !baseCommandNames.has(s.name) && meetsAvailabilityRequirement(s) && isCommandEnabled(s),
  )

  if (uniqueDynamicSkills.length === 0) {
    return baseCommands
  }

  // 将动态技能插入到插件技能之后、内置命令之前
  const builtInNames = new Set(COMMANDS().map((c) => c.name))
  const insertIndex = baseCommands.findIndex((c) => builtInNames.has(c.name))

  if (insertIndex === -1) {
    return [...baseCommands, ...uniqueDynamicSkills]
  }

  return [
    ...baseCommands.slice(0, insertIndex),
    ...uniqueDynamicSkills,
    ...baseCommands.slice(insertIndex),
  ]
}

/**
 * 仅清除命令的 memoization 缓存，不清除技能缓存。
 * 当添加动态技能时使用此函数来使缓存的命令列表失效。
 */
export function clearCommandMemoizationCaches(): void {
  loadAllCommands.cache?.clear?.()
  getSkillToolCommands.cache?.clear?.()
  getSlashCommandToolSkills.cache?.clear?.()
  // skillSearch/localSearch.ts 中的 getSkillIndex 是独立的 memoization 层，
  // 构建在 getSkillToolCommands/getCommands 之上。仅清除内部缓存对外层无效 —
  // lodash memoize 会直接返回缓存的结果，而不会触及已被清除的内层缓存。因此必须显式清除它。
  clearSkillIndexCache?.()
}

export function clearCommandsCache(): void {
  clearCommandMemoizationCaches()
  clearPluginCommandCache()
  clearPluginSkillsCache()
  clearSkillCaches()
}

/**
 * 从 AppState.mcp.commands 中筛选出 MCP 提供的技能（prompt 类型、
 * 可调用模型、从 MCP 加载）。这些放在 getCommands() 之外，
 * 以便需要在技能索引中包含 MCP 技能的调用方可以单独传递它们。
 */
export function getMcpSkillCommands(mcpCommands: readonly Command[]): readonly Command[] {
  if (feature('MCP_SKILLS')) {
    return mcpCommands.filter(
      (cmd) => cmd.type === 'prompt' && cmd.loadedFrom === 'mcp' && !cmd.disableModelInvocation,
    )
  }
  return []
}

// SkillTool 显示模型可以调用的所有基于 prompt 的命令
// 包括技能（来自 /skills/）和命令（来自 /commands/）
export let getSkillToolCommands: ((cwd: string) => Promise<Command[]>) & {
  cache?: { clear?(): void }
}
getSkillToolCommands = memoize(async (cwd: string): Promise<Command[]> => {
  const allCommands = await getCommands(cwd)
  return allCommands.filter(
    (cmd) =>
      cmd.type === 'prompt' &&
      !cmd.disableModelInvocation &&
      cmd.source !== 'builtin' &&
      // 始终包含来自 /skills/ 目录的技能、预置技能和遗留的 /commands/ 条目
      // （如果缺少 frontmatter，它们都会从第一行自动生成描述）。
      // 插件/MCP 命令仍需要显式描述才能出现在列表中。
      (cmd.loadedFrom === 'bundled' ||
        cmd.loadedFrom === 'skills' ||
        cmd.loadedFrom === 'commands_DEPRECATED' ||
        cmd.hasUserSpecifiedDescription ||
        cmd.whenToUse),
  )
})

// 筛选命令，仅包含技能。技能是为模型提供专用能力的命令。
// 通过 loadedFrom 为 'skills'、'plugin' 或 'bundled'，
// 或设置了 disableModelInvocation 来识别。
export let getSlashCommandToolSkills: ((cwd: string) => Promise<Command[]>) & {
  cache?: { clear?(): void }
}
getSlashCommandToolSkills = memoize(async (cwd: string): Promise<Command[]> => {
  try {
    const allCommands = await getCommands(cwd)
    return allCommands.filter(
      (cmd) =>
        cmd.type === 'prompt' &&
        cmd.source !== 'builtin' &&
        (cmd.hasUserSpecifiedDescription || cmd.whenToUse) &&
        (cmd.loadedFrom === 'skills' ||
          cmd.loadedFrom === 'plugin' ||
          cmd.loadedFrom === 'bundled' ||
          cmd.disableModelInvocation),
    )
  } catch (error) {
    logError(toError(error))
    // 返回空数组而不是抛出异常 — 技能是非关键的
    // 这可以防止技能加载失败破坏整个系统
    logForDebugging('Returning empty skills array due to load failure')
    return []
  }
})

/**
 * 在远程模式 (--remote) 下可安全使用的命令。
 * 这些命令仅影响本地 TUI 状态，不依赖本地文件系统、
 * git、shell、IDE、MCP 或其他本地执行上下文。
 *
 * 在两个地方使用：
 * 1. REPL 渲染前在 main.tsx 中预过滤命令（防止与 CCR 初始化竞争）
 * 2. CCR 过滤后在 REPL 的 handleRemoteInit 中保留本地专属命令
 */
export const REMOTE_SAFE_COMMANDS: Set<Command> = new Set([
  session, // 显示远程会话的二维码 / URL
  exit, // 退出 TUI
  clear, // 清屏
  help, // 显示帮助
  theme, // 更改终端主题
  color, // 更改代理颜色
  tui, // 切换全屏 TUI 模式
  vim, // 切换 vim 模式
  usage, // 显示会话成本 + 使用信息（别名 /cost）
  copy, // 复制最后一条消息
  btw, // 快速备注
  feedback, // 发送反馈
  plan, // 切换计划模式
  keybindings, // 快捷键管理
  statusline, // 状态栏切换
  stickers, // 贴纸
  mobile, // 移动端二维码
])

/**
 * 类型为 'local' 的内置命令，在通过远控桥接收时可以安全执行。
 * 这些命令产生文本输出并流式返回到移动端/Web 客户端，
 * 且没有仅限终端的副作用。
 *
 * 'local-jsx' 命令按类型阻止（它们渲染 Ink UI），
 * 'prompt' 命令按类型允许（它们展开为发送给模型的文本） —
 * 此集合仅控制 'local' 命令。
 *
 * 当添加新的应从移动端工作的 'local' 命令时，添加到此处。
 * 默认情况下被阻止。
 */
export const BRIDGE_SAFE_COMMANDS: Set<Command> = new Set(
  [
    compact, // 缩减上下文 — 在会话中从手机操作时很有用
    clear, // 清除对话记录
    summary, // 总结对话
    releaseNotes, // 显示变更日志
    files, // 列出跟踪的文件
  ].filter((c): c is Command => c !== null),
)

/**
 * 判断斜杠命令在其输入通过远控桥（移动端/Web 客户端）到达时是否可以安全执行。
 *
 * PR #19134  blanket-blocked 所有来自桥接入站的斜杠命令，
 * 因为来自 iOS 的 `/model` 会弹出本地 Ink 选择器。
 * 此谓词通过显式允许列表放宽了该限制：
 * 'prompt' 命令（技能）展开为文本，从结构上就是安全的；
 * 'local' 命令需要通过 BRIDGE_SAFE_COMMANDS 显式启用；
 * 'local-jsx' 命令渲染 Ink UI，保持阻止。
 */
export function isBridgeSafeCommand(cmd: Command): boolean {
  if (cmd.type === 'local-jsx') {
    return false
  }
  if (cmd.type === 'prompt') {
    return true
  }
  return BRIDGE_SAFE_COMMANDS.has(cmd)
}

/**
 * Narrow list of command names that render interactive Ink UI unsuitable for
 * background (tmux) sessions.  Matches CC 2.1.209 behavior — most commands
 * work fine in bg; only truly interactive flows (OAuth, installer wizards)
 * are blocked.
 */
const BG_UNSAFE_COMMAND_NAMES = new Set(['install-github-app', 'plugin'])

/**
 * Check whether a command should be blocked in a background session.
 * Returns a user-facing message when blocked, or null when allowed.
 */
export function getBgSessionBlockReason(cmd: Command): string | null {
  if (!isBgSession()) return null
  if (cmd.type !== 'local-jsx') return null
  // Only local-jsx commands with interactive UI are blocked
  if (BG_UNSAFE_COMMAND_NAMES.has(cmd.name)) {
    return `/${cmd.name} is not available in background sessions`
  }
  return null
}

/**
 * 筛选命令，仅包含在远程模式下安全的命令。
 * 用于在 --remote 模式下渲染 REPL 时预过滤命令，
 * 防止本地专属命令在 CCR 初始化消息到达前短暂可用。
 */
export function filterCommandsForRemoteMode(commands: Command[]): Command[] {
  return commands.filter((cmd) => REMOTE_SAFE_COMMANDS.has(cmd))
}

export function findCommand(commandName: string, commands: Command[]): Command | undefined {
  return commands.find(
    (_) =>
      _.name === commandName ||
      getCommandName(_) === commandName ||
      _.aliases?.includes(commandName),
  )
}

export function hasCommand(commandName: string, commands: Command[]): boolean {
  return findCommand(commandName, commands) !== undefined
}

export function getCommand(commandName: string, commands: Command[]): Command {
  const command = findCommand(commandName, commands)
  if (!command) {
    throw ReferenceError(
      `Command ${commandName} not found. Available commands: ${commands
        .map((_) => {
          const name = getCommandName(_)
          return _.aliases ? `${name} (aliases: ${_.aliases.join(', ')})` : name
        })
        .sort((a, b) => a.localeCompare(b))
        .join(', ')}`,
    )
  }

  return command
}

/**
 * 翻译命令描述。
 * 如果存在翻译 key 则返回翻译后的字符串，否则返回原始 description。
 */
export function translateCommandDescription(cmd: Command): string {
  const key = COMMAND_DESCRIPTION_I18N_KEYS[cmd.name]
  if (key) {
    return tSync(key)
  }
  return cmd.description
}

/**
 * 为面向用户的 UI 格式化命令描述，附带来源标注。
 * 在输入提示、帮助屏幕等用户需要查看命令来源的地方使用。
 *
 * 对于面向模型的提示（如 SkillTool），直接使用 cmd.description。
 */
export function formatDescriptionWithSource(cmd: Command): string {
  const translatedDesc = translateCommandDescription(cmd)

  if (cmd.type !== 'prompt') {
    return translatedDesc
  }

  if (cmd.kind === 'workflow') {
    return `${translatedDesc} (${tSync('commands.source.workflow')})`
  }

  if (cmd.source === 'plugin') {
    const pluginName = cmd.pluginInfo?.pluginManifest.name
    if (pluginName) {
      return `(${pluginName}) ${translatedDesc}`
    }
    return `${translatedDesc} (${tSync('commands.source.plugin')})`
  }

  if (cmd.source === 'builtin' || cmd.source === 'mcp') {
    return translatedDesc
  }

  if (cmd.source === 'bundled') {
    return `${translatedDesc} (${tSync('commands.source.bundled')})`
  }

  return `${translatedDesc} (${getSettingSourceName(cmd.source)})`
}
