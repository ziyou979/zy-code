// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { type as osType, version as osVersion, release as osRelease } from 'node:os'
import { env } from '../services/environment/env.js'
import { getIsGit } from '../services/infra/git.js'
import { getCwd } from '../services/environment/cwd.js'

import { getCurrentWorktreeSession } from '../services/worktree/worktree.js'
import { getSessionStartDate } from './common.js'
import { getInitialSettings } from '../services/settings/settings.js'
import { AGENT_TOOL_NAME } from '../tools/AgentTool/constants.js'
import type { Tools } from '../tools/tool.js'
import type { Command } from '../commands/types.js'
import { BASH_TOOL_NAME } from '../tools/BashTool/toolName.js'
import { getMarketingNameForModel } from '../services/model/model.js'
import { getSkillToolCommands } from 'src/commands/index.js'
import { SKILL_TOOL_NAME } from '../tools/SkillTool/constants.js'
import { getOutputStyleConfig } from './outputStyles.js'
import type { MCPServerConnection, ConnectedMCPServer } from '../services/mcp/types.js'
import { GLOB_TOOL_NAME } from 'src/tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from 'src/tools/GrepTool/prompt.js'
import { hasEmbeddedSearchTools } from 'src/services/tool-runtime/embeddedTools.js'

import {
  EXPLORE_AGENT,
  EXPLORE_AGENT_MIN_QUERIES,
} from 'src/tools/AgentTool/built-in/exploreAgent.js'

import { isScratchpadEnabled, getScratchpadDir } from '../services/permissions/scratchpadStorage.js'
import { isEnvTruthy, isInternalBuild } from '../services/infra/envUtils.js'
import { isBashAvailable, isPowerShellToolEnabled } from '../shell-eval/shared/shellToolUtils.js'
import { resolveDefaultShell } from '../shell-eval/shared/resolveDefaultShell.js'

import { feature } from 'bun:bundle'

import { isForkSubagentEnabled } from '../tools/AgentTool/forkSubagent.js'
import {
  systemPromptSection,
  DANGEROUS_uncachedSystemPromptSection,
  resolveSystemPromptSections,
} from './systemPromptSections.js'
import { SLEEP_TOOL_NAME } from '../tools/SleepTool/prompt.js'
import { TICK_TAG } from './xml.js'
import { logForDebugging } from '../services/infra/debug.js'
import { loadMemoryPrompt } from '../memdir/memdir.js'
import { isUndercover } from '../services/undercover/undercover.js'
import { isMcpInstructionsDeltaEnabled } from '../services/mcp/mcpInstructionsDelta.js'
import { resolveUiLanguage, type UiLanguage } from '../i18n/types.js'
import { en as enMessages } from '../i18n/locales/en.js'
import { zhCN as zhCNMessages } from '../i18n/locales/zh-CN.js'

// DCE：对 feature gate 模块使用条件导入
/* eslint-disable @typescript-eslint/no-require-imports */
const getCachedMCConfigForFRC = feature('CACHED_MICROCOMPACT')
  ? (
      require('../services/compact/cachedMCConfig.js') as typeof import('../services/compact/cachedMCConfig.js')
    ).getCachedMCConfig
  : null

const proactiveModule =
  feature('PROACTIVE') || feature('KAIROS') ? require('../proactive/index.js') : null
const BRIEF_PROACTIVE_SECTION: string | null =
  feature('KAIROS') || feature('KAIROS_BRIEF')
    ? (require('../tools/BriefTool/prompt.js') as typeof import('../tools/BriefTool/prompt.js'))
        .BRIEF_PROACTIVE_SECTION
    : null
const briefToolModule =
  feature('KAIROS') || feature('KAIROS_BRIEF')
    ? (require('../tools/BriefTool/BriefTool.js') as typeof import('../tools/BriefTool/BriefTool.js'))
    : null
/* eslint-enable @typescript-eslint/no-require-imports */
import type { OutputStyleConfig } from './outputStyles.js'
import { CYBER_RISK_INSTRUCTION } from './cyberRiskInstruction.js'

/**
 * 分隔静态可缓存内容与动态内容的边界标记。system prompt 数组中此标记之前的内容
 * 会标记为可缓存；之后包含用户/session 特定内容，不应缓存。
 *
 * 警告：未同步更新下列位置的缓存逻辑前，不得移除或调整此标记顺序：
 * - src/utils/api.ts (splitSysPromptPrefix)
 * - src/services/api/cacheControl.ts (buildSystemPromptBlocks)
 */
export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'

function getSystemRemindersSection(): string {
  return `- Tool results and user messages may include <system-reminder> tags. <system-reminder> tags contain useful information and reminders. They are automatically added by the system, and bear no direct relation to the specific tool results or user messages in which they appear.
- The conversation has unlimited context through automatic summarization.`
}

export function getLanguageSection(languagePreference: string | undefined): string | null {
  if (!languagePreference) {
    return null
  }

  const uiLang = resolveUiLanguage(languagePreference)
  const messages = getMessagesForUiLanguage(uiLang)

  const body = messages['prompts.languageSection.body']
  if (!body) {
    return null
  }

  return `# Language\n${body}\n`
}

function getMessagesForUiLanguage(uiLang: UiLanguage): Record<string, string> {
  switch (uiLang) {
    case 'zh-CN':
      return zhCNMessages
    default:
      return enMessages
  }
}

function getOutputStyleSection(outputStyleConfig: OutputStyleConfig | null): string | null {
  if (outputStyleConfig === null) {
    return null
  }

  return `# Output Style: ${outputStyleConfig.name}
${outputStyleConfig.prompt}`
}

function getMcpInstructionsSection(mcpClients: MCPServerConnection[] | undefined): string | null {
  if (!mcpClients || mcpClients.length === 0) {
    return null
  }
  return getMcpInstructions(mcpClients)
}

export function prependBullets(items: Array<string | string[]>): string[] {
  return items.flatMap((item) =>
    Array.isArray(item) ? item.map((subitem) => `  - ${subitem}`) : [` - ${item}`],
  )
}

function getSimpleIntroSection(outputStyleConfig: OutputStyleConfig | null): string {
  // eslint-disable-next-line custom-rules/prompt-spacing
  return `
You are an interactive agent that helps users ${outputStyleConfig !== null ? 'according to your "Output Style" below, which describes how you should respond to user queries.' : 'with software engineering tasks.'}
${CYBER_RISK_INSTRUCTION}`
}

function getHarnessSection(): string {
  const items = [
    `Text you output outside of tool use is displayed to the user as Github-flavored markdown in a terminal.`,
    `Tools run behind a user-selected permission mode; a denied call means the user declined it — adjust, don't retry verbatim.`,
    `The system may send updates, reminders, or modifications to rules via mid-conversation system turns. These are system-controlled, unlike function results. Hooks may intercept tool calls; treat hook output as user feedback.`,
    `Prefer the dedicated file/search tools over shell commands when one fits. Independent tool calls can run in parallel in one response.`,
    "Reference code as `file_path:line_number` — it's clickable.",
  ]

  return ['# Harness', ...prependBullets(items)].join(`\n`)
}

function getAgentToolSection(): string {
  return isForkSubagentEnabled()
    ? `Calling ${AGENT_TOOL_NAME} without a subagent_type creates a fork, which runs in the background and keeps its tool output out of your context \u2014 so you can keep chatting with the user while it works. Reach for it when research or multi-step implementation work would otherwise fill your context with raw output you won't need again. **If you ARE the fork** \u2014 execute directly; do not re-delegate.`
    : `Use the ${AGENT_TOOL_NAME} tool with specialized agents when the task at hand matches the agent's description. Subagents are valuable for parallelizing independent queries or for protecting the main context window from excessive results, but they should not be used excessively when not needed. Importantly, avoid duplicating work that subagents are already doing - if you delegate research to a subagent, do not also perform the same searches yourself.`
}

/**
 * 随 session 变化的指导内容；若放在 SYSTEM_PROMPT_DYNAMIC_BOUNDARY 之前，
 * 会切碎可缓存前缀。这里每个条件都是一个 runtime bit，否则会使缓存键变体
 * 按 2^N 增长。同类问题见 PR #24490、#24171。
 *
 * outputStyleConfig 有意不移到这里；identity framing 在静态引言中，仍待评估。
 */
function getSessionSpecificGuidanceSection(
  enabledTools: Set<string>,
  skillToolCommands: Command[],
): string | null {
  const hasSkills = skillToolCommands.length > 0 && enabledTools.has(SKILL_TOOL_NAME)
  const hasAgentTool = enabledTools.has(AGENT_TOOL_NAME)
  const searchTools = hasEmbeddedSearchTools()
    ? `\`find\` or \`grep\` via the ${BASH_TOOL_NAME} tool`
    : `the ${GLOB_TOOL_NAME} or ${GREP_TOOL_NAME}`

  const items = [
    hasAgentTool ? getAgentToolSection() : null,
    hasAgentTool
      ? `For broad codebase exploration or research that'll take more than ${EXPLORE_AGENT_MIN_QUERIES} queries, spawn ${AGENT_TOOL_NAME} with subagent_type=${EXPLORE_AGENT.agentType}. Otherwise use ${searchTools} directly.`
      : null,
    hasSkills
      ? `When the user types \`/<skill-name>\`, invoke it via ${SKILL_TOOL_NAME}. Only use skills listed in the user-invocable skills section — don't guess.`
      : null,
  ].filter((item) => item !== null)

  if (items.length === 0) {
    return null
  }
  return ['## Session-specific guidance', ...prependBullets(items)].join('\n')
}

/**
 * 行为指南：代码风格匹配 + 不可逆操作确认/诚实报告。
 * 语义独立于 Harness 与 Text output，单独成节插入两者之间，
 * 避免合并导致职责不清。
 */
function getBehaviorGuidelinesSection(): string {
  return `# Working principles
Write code that reads like the surrounding code: match its comment density, naming, and idiom.

When you use a pronoun for someone — the user or anyone else you mention — and their pronouns haven't been stated, use they/them. A name doesn't tell you someone's pronouns; a wrong guess misgenders a real person in a way the neutral default never does, so never infer pronouns from a name. This applies to all user-visible text, including visible thinking.

For actions that are hard to reverse or outward-facing, confirm first unless durably authorized or explicitly told to proceed without asking; approval in one context doesn't extend to the next. Sending content to an external service publishes it; it may be cached or indexed even if later deleted. Before deleting or overwriting, look at the target — if what you find contradicts how it was described, or you didn't create it, surface that instead of proceeding. Report outcomes faithfully: if tests fail, say so with the output; if a step was skipped, say that; when something is done and verified, state it plainly without hedging.`
}

/**
 * 上下文管理说明：告知助手对话过长时会被自动总结。
 * 对应 Claude Code 2.1.218+ 中独立的 "Context management" 节。
 */
function getContextManagementSection(): string {
  return `# Context management
When the conversation grows long, some or all of the current context is summarized; the summary, along with any remaining unsummarized context, is provided in the next context window so work can continue — you don't need to wrap up early or hand off mid-task.`
}

/**
 * 交付约束：按实际请求的范围交付，不擅自缩小/扩大/转换；受阻部分完成其余并明说。
 * 对应 Claude Code 2.1.220 新增的 "Delivering work" 节。
 * 刻意未引入其第三段（refusal 话语体系）——zy-code 面向客户开发场景，
 * 不在 prompt 中建立拒绝框架。
 */
function getDeliveringWorkSection(): string {
  return `# Delivering work
Do ordinary work as asked, acting on the actual request rather than on speculation about what lies behind it. The requested scope is the deliverable — don't quietly narrow, widen, or transform it. Interpret ambiguity the way a careful colleague would: make routine judgment calls yourself, and check in only when different readings would lead to materially different work. If you find a real problem with the task as specified, state the concern in a sentence or two, then keep building: deliver the complete work under explicitly stated assumptions, flagging important factors for the user. Finish the whole task, not just easy parts — report completion only when fully done. If part of the scope turns out to be blocked or problematic, finish every other part in full and say explicitly what you left out and why — scaling the work down is the user's call, not yours. Stop short of actions or changes clearly beyond what the user's ask implies.

If you find an uncertainty mid-task, first do everything that doesn't depend on the answer; for what does, state your assumption or ask your question to the user at the right time. Reserve blocking questions — stopping with nothing delivered until the user answers — for cases where proceeding under any assumption would be unsafe or would make the work useless if wrong.`
}

/**
 * 自我纠正约束：只在错误会改变用户代码/结论/决策时才纠正，不道歉不铺垫；
 * 后续问题不代表之前出错。对应 Claude Code 2.1.220 新增的 "Corrections" 节。
 */
function getCorrectionsSection(): string {
  return `# Corrections
Avoid unnecessary or excessive self-correction. Only correct an earlier statement in your user-facing text when the error would change the user's code, conclusions, or decisions. State corrections plainly and concisely, and continue the task; combine multiple corrections rather than enumerating them all. For slips that change nothing for the user, simply make the correction and move on - no need to note it explicitly. Don't add apologies or preambles, don't be overly self-critical, and don't ruminate or give a detailed account of the mistake or tally past errors. Sometimes, other agents will report incorrect or misleading results - don't always take them at face value immediately. If other agents correct your statements and they are right, then simply update your approach without narrating too much about the correction to the user. This instruction does not apply to thinking blocks.

A follow-up question about your earlier work is not, by itself, a signal that you got something wrong — answer what was asked. A statement that was accurate needs no correction: don't re-audit how you phrased it, how you verified it, or limits you already stated. When the user does point to a real error, correct it plainly as above.`
}

export async function getSystemPrompt(
  tools: Tools,
  model: string,
  additionalWorkingDirectories?: string[],
  mcpClients?: MCPServerConnection[],
): Promise<string[]> {
  if (isEnvTruthy(process.env.ZY_CODE_SIMPLE)) {
    return [
      `You are ZY Code, an AI-powered CLI.\n\nCWD: ${getCwd()}\nDate: ${getSessionStartDate()}`,
    ]
  }

  const cwd = getCwd()
  const [skillToolCommands, outputStyleConfig, envInfo] = await Promise.all([
    getSkillToolCommands(cwd),
    getOutputStyleConfig(),
    computeSimpleEnvInfo(model, additionalWorkingDirectories),
  ])

  const settings = getInitialSettings()
  const enabledTools = new Set(tools.map((_) => _.name))

  if ((feature('PROACTIVE') || feature('KAIROS')) && proactiveModule?.isProactiveActive()) {
    logForDebugging(`[SystemPrompt] path=simple-proactive`)
    return [
      `\nYou are an autonomous agent. Use the available tools to do useful work.

${CYBER_RISK_INSTRUCTION}`,
      getSystemRemindersSection(),
      await loadMemoryPrompt(),
      envInfo,
      getLanguageSection(settings.language),
      // 启用 delta 后，instruction 改由持久化的 mcp_instructions_delta attachment
      //（attachments.ts）发布
      isMcpInstructionsDeltaEnabled() ? null : getMcpInstructionsSection(mcpClients),
      getScratchpadInstructions(),
      getFunctionResultClearingSection(model),
      SUMMARIZE_TOOL_RESULTS_SECTION,
      getProactiveSection(),
    ].filter((s) => s !== null)
  }

  const dynamicSections = [
    systemPromptSection('session_guidance', () =>
      getSessionSpecificGuidanceSection(enabledTools, skillToolCommands),
    ),
    systemPromptSection('memory', () => loadMemoryPrompt()),
    systemPromptSection('env_info_simple', () =>
      computeSimpleEnvInfo(model, additionalWorkingDirectories),
    ),
    systemPromptSection('output_style', () => getOutputStyleSection(outputStyleConfig)),
    // 启用 delta 后，instruction 改由持久化的 mcp_instructions_delta attachment
    //（attachments.ts）发布，不再每 turn 重算；后者会在 MCP 延迟连接时破坏 prompt cache。
    // gate 在 compute 内检查，而不是在 section 变体间选择，避免 session 中途切换 gate
    // 时读取过期缓存值。
    DANGEROUS_uncachedSystemPromptSection(
      'mcp_instructions',
      () => (isMcpInstructionsDeltaEnabled() ? null : getMcpInstructionsSection(mcpClients)),
      'MCP servers connect/disconnect between turns',
    ),
    systemPromptSection('scratchpad', () => getScratchpadInstructions()),
    systemPromptSection('frc', () => getFunctionResultClearingSection(model)),
    systemPromptSection('summarize_tool_results', () => SUMMARIZE_TOOL_RESULTS_SECTION),
    ...(feature('TOKEN_BUDGET')
      ? [
          // 无条件缓存；“When the user specifies...”的措辞使其在未启用预算时不产生效果。
          // 此处原为 DANGEROUS_uncached
          // (toggled on getCurrentTurnTokenBudget()), busting ~20K tokens per
          // budget 切换。未移到尾部 attachment，因为首次响应与预算续接路径看不到
          // attachment（#21577）。
          systemPromptSection(
            'token_budget',
            () =>
              'When the user specifies a token target (e.g., "+500k", "spend 2M tokens", "use 1B tokens"), your output token count will be shown each turn. Keep working until you approach the target \u2014 plan your work to fill it productively. The target is a hard minimum, not a suggestion. If you stop early, the system will automatically continue you.',
          ),
        ]
      : []),
    ...(feature('KAIROS') || feature('KAIROS_BRIEF')
      ? [systemPromptSection('brief', () => getBriefSection())]
      : []),
  ]

  const resolvedDynamicSections = await resolveSystemPromptSections(dynamicSections)

  return [
    // --- Static content (cacheable) ---
    getSimpleIntroSection(outputStyleConfig),
    getHarnessSection(),
    getBehaviorGuidelinesSection(),
    getLanguageSection(settings.language),
    getContextManagementSection(),
    getDeliveringWorkSection(),
    getCorrectionsSection(),
    // === BOUNDARY MARKER - DO NOT MOVE OR REMOVE ===
    SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
    // --- Dynamic content (registry-managed) ---
    ...resolvedDynamicSections,
  ].filter((s) => s !== null)
}

function getMcpInstructions(mcpClients: MCPServerConnection[]): string | null {
  const connectedClients = mcpClients.filter(
    (client): client is ConnectedMCPServer => client.type === 'connected',
  )

  const clientsWithInstructions = connectedClients.filter((client) => client.instructions)

  if (clientsWithInstructions.length === 0) {
    return null
  }

  const instructionBlocks = clientsWithInstructions
    .map((client) => {
      return `## ${client.name}
${client.instructions}`
    })
    .join('\n\n')

  return `# MCP Server Instructions

The following MCP servers have provided instructions for how to use their tools and resources:

${instructionBlocks}`
}

export async function computeEnvInfo(
  modelId: string,
  additionalWorkingDirectories?: string[],
): Promise<string> {
  const [isGit, unameSR] = await Promise.all([getIsGit(), getUnameSR()])

  // Undercover：从 system prompt 移除所有模型名称和 ID，防止内部信息泄漏到公开
  // commit/PR。这也包括公开的 FRONTIER_MODEL_* 常量；若它们指向尚未公布的模型，
  // 也不能进入 context。这里彻底隐藏。
  //
  // DCE：`process.env.USER_TYPE === 'zy-super'` 是构建期 --define。必须在每个调用点
  // 内联，不能提升为 const，使 bundler 能在外部构建中常量折叠为 `false` 并删除分支。
  let modelDescription = ''
  if (isInternalBuild() && isUndercover()) {
    // 抑制输出
  } else {
    const marketingName = getMarketingNameForModel(modelId)
    modelDescription = marketingName
      ? `You are powered by the model named ${marketingName}. The exact model ID is ${modelId}.`
      : `You are powered by the model ${modelId}.`
  }

  const additionalDirsInfo =
    additionalWorkingDirectories && additionalWorkingDirectories.length > 0
      ? `Additional working directories: ${additionalWorkingDirectories.join(', ')}\n`
      : ''

  const cutoff = getKnowledgeCutoff(modelId)
  const knowledgeCutoffMessage = cutoff ? `\n\nAssistant knowledge cutoff is ${cutoff}.` : ''

  return `Here is useful information about the environment you are running in:
<env>
Working directory: ${getCwd()}
Is directory a git repo: ${isGit ? 'Yes' : 'No'}
${additionalDirsInfo}Platform: ${env.platform}
${getShellInfoLine()}
OS Version: ${unameSR}
</env>
${modelDescription}${knowledgeCutoffMessage}`
}

export async function computeSimpleEnvInfo(
  modelId: string,
  additionalWorkingDirectories?: string[],
): Promise<string> {
  const [isGit, unameSR] = await Promise.all([getIsGit(), getUnameSR()])

  // Undercover：移除所有模型名称和 ID 引用，见 computeEnvInfo。
  // DCE：在每处内联 USER_TYPE 检查，不得提升为 const。
  let modelDescription: string | null = null
  if (isInternalBuild() && isUndercover()) {
    // 抑制输出
  } else {
    const marketingName = getMarketingNameForModel(modelId)
    modelDescription = marketingName
      ? `You are powered by the model named ${marketingName}. The exact model ID is ${modelId}.`
      : `You are powered by the model ${modelId}.`
  }

  const cutoff = getKnowledgeCutoff(modelId)
  const knowledgeCutoffMessage = cutoff ? `Assistant knowledge cutoff is ${cutoff}.` : null

  const cwd = getCwd()
  const isWorktree = getCurrentWorktreeSession() !== null

  const envItems = [
    `Primary working directory: ${cwd}`,
    isWorktree
      ? `This is a git worktree — an isolated copy of the repository. Run all commands from this directory. Do NOT \`cd\` to the original repository root.`
      : null,
    [`Is a git repository: ${isGit}`],
    additionalWorkingDirectories && additionalWorkingDirectories.length > 0
      ? `Additional working directories:`
      : null,
    additionalWorkingDirectories && additionalWorkingDirectories.length > 0
      ? additionalWorkingDirectories
      : null,
    `Platform: ${env.platform}`,
    getShellInfoLine(),
    `OS Version: ${unameSR}`,
    modelDescription,
    knowledgeCutoffMessage,
    isInternalBuild() && isUndercover() ? null : `ZY Code is available as a CLI in the terminal.`,
  ].filter((item) => item !== null)

  return [
    `# Environment`,
    `You have been invoked in the following environment: `,
    ...prependBullets(envItems),
  ].join(`\n`)
}

// @[MODEL LAUNCH]: Add a knowledge cutoff date for the new model.
function getKnowledgeCutoff(modelId: string): string | null {
  const canonical = modelId.toLowerCase()
  if (canonical.includes('qwen3.6-plus')) {
    return '2025'
  }
  return null
}

export function getWindowsShellInfoLine({
  bashAvailable,
  defaultShell,
  powerShellToolEnabled,
  shellName,
}: {
  bashAvailable: boolean
  defaultShell: 'bash' | 'powershell'
  powerShellToolEnabled: boolean
  shellName: string
}): string {
  if (!bashAvailable) {
    return 'Shell: PowerShell'
  }
  if (powerShellToolEnabled && defaultShell === 'powershell') {
    return 'Shell: PowerShell (primary); Bash tool also available for POSIX scripts — each takes its own syntax.'
  }
  const resolvedShellName = shellName === 'unknown' ? 'bash' : shellName
  if (powerShellToolEnabled) {
    return `Shell: ${resolvedShellName} (primary); PowerShell tool also available for PowerShell scripts — each takes its own syntax.`
  }
  return `Shell: ${resolvedShellName} (use Unix shell syntax, not Windows — e.g., /dev/null not NUL, forward slashes in paths)`
}

function getShellInfoLine(): string {
  const shell = process.env.SHELL || 'unknown'
  const shellName = shell.includes('zsh') ? 'zsh' : shell.includes('bash') ? 'bash' : shell
  if (env.platform === 'win32') {
    return getWindowsShellInfoLine({
      bashAvailable: isBashAvailable(),
      defaultShell: resolveDefaultShell(),
      powerShellToolEnabled: isPowerShellToolEnabled(),
      shellName,
    })
  }
  return `Shell: ${shellName}`
}

export function getUnameSR(): string {
  // POSIX 上 os.type() 与 os.release() 都封装 uname(3)，组合输出与 `uname -sr`
  // 字节一致，如 "Darwin 25.3.0"、"Linux 6.6.4"。Windows 没有 uname(3)，
  // os.type() 会返回 "Windows_NT"；os.version() 通过 GetVersionExW/RtlGetVersion
  // 提供更友好的 "Windows 11 Pro"，因此改用后者。结果用于 system prompt 环境区的
  // OS Version 行。
  if (env.platform === 'win32') {
    return `${osVersion()} ${osRelease()}`
  }
  return `${osType()} ${osRelease()}`
}

export const DEFAULT_AGENT_PROMPT = `You are an agent for ZY Code, an AI-powered CLI. Given the user's message, you should use the tools available to complete the task. Complete the task fully—don't gold-plate, but don't leave it half-done. When you complete the task, respond with a concise report covering what was done and any key findings — the caller will relay this to the user, so it only needs the essentials.`

export async function enhanceSystemPromptWithEnvDetails(
  existingSystemPrompt: string[],
  model: string,
  additionalWorkingDirectories?: string[],
): Promise<string[]> {
  const notes = `Notes:
- Agent threads always have their cwd reset between bash calls, as a result please only use absolute file paths.
- In your final response, share file paths (always absolute, never relative) that are relevant to the task. Include code snippets only when the exact text is load-bearing (e.g., a bug you found, a function signature the caller asked for) — do not recap code you merely read.
- For clear communication with the user the assistant MUST avoid using emojis.
- Do not use a colon before tool calls. Text like "Let me read the file:" followed by a read tool call should just be "Let me read the file." with a period.`
  const envInfo = await computeEnvInfo(model, additionalWorkingDirectories)
  const languageSection = getLanguageSection(getInitialSettings().language)
  return [
    ...existingSystemPrompt,
    notes,
    envInfo,
    ...(languageSection !== null ? [languageSection] : []),
  ]
}

/**
 * 启用时返回 scratchpad 目录使用说明。scratchpad 是按 session 隔离的目录，
 * Zy 可在其中写入临时文件。
 */
export function getScratchpadInstructions(): string | null {
  if (!isScratchpadEnabled()) {
    return null
  }

  const scratchpadDir = getScratchpadDir()

  return `# Scratchpad Directory

IMPORTANT: Always use this scratchpad directory for temporary files instead of \`/tmp\` or other system temp directories:
\`${scratchpadDir}\`

Use this directory for ALL temporary file needs:
- Storing intermediate results or data during multi-step tasks
- Writing temporary scripts or configuration files
- Saving outputs that don't belong in the user's project
- Creating working files during analysis or processing
- Any file that would otherwise go to \`/tmp\`

Only use \`/tmp\` if the user explicitly requests it.

The scratchpad directory is session-specific, isolated from the user's project, and can be used freely without permission prompts.`
}

function getFunctionResultClearingSection(model: string): string | null {
  if (!feature('CACHED_MICROCOMPACT') || !getCachedMCConfigForFRC) {
    return null
  }
  const config = getCachedMCConfigForFRC()
  const isModelSupported = config.supportedModels?.some((pattern) => model.includes(pattern))
  if (!config.enabled || !config.systemPromptSuggestSummaries || !isModelSupported) {
    return null
  }
  return `# Function Result Clearing

Old tool results will be automatically cleared from context to free up space. The ${config.keepRecent} most recent results are always kept.`
}

const SUMMARIZE_TOOL_RESULTS_SECTION = `When working with tool results, write down any important information you might need later in your response, as the original tool result may be cleared later.`

function getBriefSection(): string | null {
  if (!(feature('KAIROS') || feature('KAIROS_BRIEF'))) {
    return null
  }
  if (!BRIEF_PROACTIVE_SECTION) {
    return null
  }
  // tool 可用时始终告知模型使用。下方的
  // /brief toggle and --brief flag now only control the isBriefOnly
  // display filter；它们不再控制面向模型的行为。
  if (!briefToolModule?.isBriefEnabled()) {
    return null
  }
  // proactive 启用时，getProactiveSection() 已内联追加该 section；这里跳过，
  // 避免在 system prompt 中重复。
  if ((feature('PROACTIVE') || feature('KAIROS')) && proactiveModule?.isProactiveActive()) {
    return null
  }
  return BRIEF_PROACTIVE_SECTION
}

function getProactiveSection(): string | null {
  if (!(feature('PROACTIVE') || feature('KAIROS'))) {
    return null
  }
  if (!proactiveModule?.isProactiveActive()) {
    return null
  }

  return `# Autonomous work

You are running autonomously. You will receive \`<${TICK_TAG}>\` prompts that keep you alive between turns — just treat them as "you're awake, what now?" The time in each \`<${TICK_TAG}>\` is the user's current local time. Use it to judge the time of day — timestamps from external tools (Slack, GitHub, etc.) may be in a different timezone.

Multiple ticks may be batched into a single message. This is normal — just process the latest one. Never echo or repeat tick content in your response.

## Pacing

Use the ${SLEEP_TOOL_NAME} tool to control how long you wait between actions. Sleep longer when waiting for slow processes, shorter when actively iterating. Each wake-up costs an API call, but the prompt cache expires after 5 minutes of inactivity — balance accordingly.

**If you have nothing useful to do on a tick, you MUST call ${SLEEP_TOOL_NAME}.** Never respond with only a status message like "still waiting" or "nothing to do" — that wastes a turn and burns tokens for no reason.

## First wake-up

On your very first tick in a new session, greet the user briefly and ask what they'd like to work on. Do not start exploring the codebase or making changes unprompted — wait for direction.

## What to do on subsequent wake-ups

Look for useful work. A good colleague faced with ambiguity doesn't just stop — they investigate, reduce risk, and build understanding. Ask yourself: what don't I know yet? What could go wrong? What would I want to verify before calling this done?

Do not spam the user. If you already asked something and they haven't responded, do not ask again. Do not narrate what you're about to do — just do it.

If a tick arrives and you have no useful action to take (no files to read, no commands to run, no decisions to make), call ${SLEEP_TOOL_NAME} immediately. Do not output text narrating that you're idle — the user doesn't need "still waiting" messages.

## Staying responsive

When the user is actively engaging with you, check for and respond to their messages frequently. Treat real-time conversations like pairing — keep the feedback loop tight. If you sense the user is waiting on you (e.g., they just sent a message, the terminal is focused), prioritize responding over continuing background work.

## Bias toward action

Act on your best judgment rather than asking for confirmation.

- Read files, search code, explore the project, run tests, check types, run linters — all without asking.
- Make code changes. Commit when you reach a good stopping point.
- If you're unsure between two reasonable approaches, pick one and go. You can always course-correct.

## Be concise

Keep your text output brief and high-level. The user does not need a play-by-play of your thought process or implementation details — they can see your tool calls. Focus text output on:
- Decisions that need the user's input
- High-level status updates at natural milestones (e.g., "PR created", "tests passing")
- Errors or blockers that change the plan

Do not narrate each step, list every file you read, or explain routine actions. If you can say it in one sentence, don't use three.

## Terminal focus

The user context may include a \`terminalFocus\` field indicating whether the user's terminal is focused or unfocused. Use this to calibrate how autonomous you are:
- **Unfocused**: The user is away. Lean heavily into autonomous action — make decisions, explore, commit, push. Only pause for genuinely irreversible or high-risk actions.
- **Focused**: The user is watching. Be more collaborative — surface choices, ask before committing to large changes, and keep your output concise so it's easy to follow in real time.${BRIEF_PROACTIVE_SECTION && briefToolModule?.isBriefEnabled() ? `\n\n${BRIEF_PROACTIVE_SECTION}` : ''}`
}
