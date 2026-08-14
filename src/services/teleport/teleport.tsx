import { randomUUID } from 'node:crypto'
import axios from 'axios'
import chalk from 'chalk'
import { getOriginalCwd, getSessionId } from 'src/bootstrap/runtime/runtimeContext.js'
import { checkGate_CACHED_OR_BLOCKING } from 'src/services/analytics/growthbook.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { checkGithubAppInstalled } from 'src/services/background/remote/preconditions.js'
import { getMainLoopModel } from 'src/services/model/model.js'
import { isPolicyAllowed } from 'src/services/policy-limits/index.js'
import { z } from 'zod/v4'
import { getOauthConfig } from '../../constants/oauth.js'
import type { WireMessage } from '../../types/index.js'
import type { Message, SystemMessage } from '../../types/message.js'
import type { PermissionMode } from '../../types/permissions.js'
import {
  checkAndRefreshOAuthTokenIfNeeded,
  getOrganizationUUID,
  getZyAIOAuthTokens,
} from '../auth/auth.js'
import {
  deserializeMessages,
  type TeleportRemoteResponse,
} from '../session-storage/conversationRecovery.js'
import { getCwd } from '../environment/cwd.js'
import { logForDebugging } from '../../services/infra/debug.js'
import {
  detectCurrentRepositoryWithHost,
  parseGitHubRepository,
  parseGitRemote,
} from '../git/detectRepository.js'
import { isEnvTruthy } from '../../services/infra/envUtils.js'
import { TeleportOperationError, toError } from '../../utils/errors.js'
import { execFileNoThrow } from '../shell/execFileNoThrow.js'
import { truncateToWidth } from '../../utils/format.js'
import { findGitRoot, getDefaultBranch, getIsClean, gitExe } from '../../services/infra/git.js'
import { safeParseJSON } from '../../utils/json.js'
import { logError } from '../../services/infra/log.js'
import { createSystemMessage, createUserMessage } from '../messages/constructors.js'
import { isTranscriptMessage } from '../sessionStorage.js'
import { getInitialSettings } from '../settings/settings.js'
import { jsonStringify } from '../../services/infra/slowOperations.js'
import { asSystemPrompt } from '../api/systemPromptType.js'
import { queryCompactModel } from '../api/compactQueries.js'
import { getSessionLogsViaOAuth, getTeleportEvents } from '../api/sessionIngress.js'
import {
  fetchSession,
  type GitRepositoryOutcome,
  type GitSource,
  getBranchFromSession,
  getOAuthHeaders,
  type SessionResource,
} from './api.js'
import { fetchEnvironments } from './environments.js'
import { createAndUploadGitBundle } from './gitBundle.js'
export type TeleportResult = {
  messages: Message[]
  branchName: string
}
export type TeleportProgressStep =
  | 'validating'
  | 'fetching_logs'
  | 'fetching_branch'
  | 'checking_out'
  | 'done'
export type TeleportProgressCallback = (step: TeleportProgressStep) => void

/**
 * 创建 system 消息，告知 teleport 会话已恢复。
 * @returns 表示会话已从另一台机器恢复的 SystemMessage
 */
function createTeleportResumeSystemMessage(branchError: Error | null): SystemMessage {
  if (branchError === null) {
    return createSystemMessage('Session resumed', 'suggestion')
  }
  const formattedError =
    branchError instanceof TeleportOperationError
      ? branchError.formattedMessage
      : branchError.message
  return createSystemMessage(`Session resumed without branch: ${formattedError}`, 'warning')
}

/**
 * 创建 user 消息，告知模型 teleport 会话已恢复。
 * @returns 表示会话已从另一台机器恢复的 user 消息
 */
function createTeleportResumeUserMessage() {
  return createUserMessage({
    content: [
      {
        type: 'text' as const,
        text: `This session is being continued from another machine. Application state may have changed. The updated working directory is ${getOriginalCwd()}`,
      },
    ],
    isMeta: true,
  })
}
export type TeleportToRemoteResponse = {
  id: string
  title: string
}
const SESSION_TITLE_AND_BRANCH_PROMPT = `You are coming up with a succinct title and git branch name for a coding session based on the provided description. The title should be clear, concise, and accurately reflect the content of the coding task.
You should keep it short and simple, ideally no more than 6 words. Avoid using jargon or overly technical terms unless absolutely necessary. The title should be easy to understand for anyone reading it.
Use sentence case for the title (capitalize only the first word and proper nouns), not Title Case.

The branch name should be clear, concise, and accurately reflect the content of the coding task.
You should keep it short and simple, ideally no more than 4 words. The branch should always start with "zy/" and should be all lower case, with words separated by dashes.

Return a JSON object with "title" and "branch" fields.

Example 1: {"title": "Fix login button not working on mobile", "branch": "zy/fix-mobile-login-button"}
Example 2: {"title": "Update README with installation instructions", "branch": "zy/update-readme"}
Example 3: {"title": "Improve performance of data processing script", "branch": "zy/improve-data-processing"}

Here is the session description:
<description>{description}</description>
Please generate a title and branch name for this session.`
type TitleAndBranch = {
  title: string
  branchName: string
}

/**
 * 为编码会话生成标题和分支名。
 * @param description 会话的描述或 prompt
 * @returns 生成的标题和分支名
 */
async function generateTitleAndBranch(
  description: string,
  signal: AbortSignal,
): Promise<TitleAndBranch> {
  const fallbackTitle = truncateToWidth(description, 75)
  const fallbackBranch = 'zy/task'
  try {
    const userPrompt = SESSION_TITLE_AND_BRANCH_PROMPT.replace('{description}', description)
    const response = await queryCompactModel({
      systemPrompt: asSystemPrompt([]),
      userPrompt,
      outputFormat: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: {
            title: {
              type: 'string',
            },
            branch: {
              type: 'string',
            },
          },
          required: ['title', 'branch'],
          additionalProperties: false,
        },
      },
      signal,
      options: {
        querySource: 'teleport_generate_title' as const,
        agents: [],
        isNonInteractiveSession: false,
        hasAppendSystemPrompt: false,
        mcpTools: [],
      },
    })

    // 从响应中提取文本。
    const content = response.message.content
    if (!Array.isArray(content) || content.length === 0) {
      return {
        title: fallbackTitle,
        branchName: fallbackBranch,
      }
    }
    const firstBlock = content[0]
    if (firstBlock?.type !== 'text') {
      return {
        title: fallbackTitle,
        branchName: fallbackBranch,
      }
    }
    const parsed = safeParseJSON(firstBlock.text.trim())
    const parseResult = z
      .object({
        title: z.string(),
        branch: z.string(),
      })
      .safeParse(parsed)
    if (parseResult.success) {
      return {
        title: parseResult.data.title || fallbackTitle,
        branchName: parseResult.data.branch || fallbackBranch,
      }
    }
    return {
      title: fallbackTitle,
      branchName: fallbackBranch,
    }
  } catch (error) {
    logError(new Error(`Error generating title and branch: ${error}`))
    return {
      title: fallbackTitle,
      branchName: fallbackBranch,
    }
  }
}

/**
 * 校验 git 工作目录是否干净（忽略未跟踪文件）。切换分支不会丢失未跟踪文件，
 * 因此无需将其视为脏状态。
 */
export async function validateGitState(): Promise<void> {
  const isClean = await getIsClean({
    ignoreUntracked: true,
  })
  if (!isClean) {
    logEvent('zy_teleport_error_git_not_clean', {})
    const error = new TeleportOperationError(
      'Git working directory is not clean. Please commit or stash your changes before using --teleport.',
      chalk.red(
        'Error: Git working directory is not clean. Please commit or stash your changes before using --teleport.\n',
      ),
    )
    throw error
  }
}

/**
 * 从远程 origin 获取指定分支。
 * @param branch 要获取的分支；未指定时获取全部分支
 */
async function fetchFromOrigin(branch?: string): Promise<void> {
  const fetchArgs = branch ? ['fetch', 'origin', `${branch}:${branch}`] : ['fetch', 'origin']
  const { code: fetchCode, stderr: fetchStderr } = await execFileNoThrow(gitExe(), fetchArgs)
  if (fetchCode !== 0) {
    // 获取指定分支失败时，该分支可能尚不存在于本地；尝试只获取 ref，
    // 不映射到本地分支。
    if (branch && fetchStderr.includes('refspec')) {
      logForDebugging(`Specific branch fetch failed, trying to fetch ref: ${branch}`)
      const { code: refFetchCode, stderr: refFetchStderr } = await execFileNoThrow(gitExe(), [
        'fetch',
        'origin',
        branch,
      ])
      if (refFetchCode !== 0) {
        logError(new Error(`Failed to fetch from remote origin: ${refFetchStderr}`))
      }
    } else {
      logError(new Error(`Failed to fetch from remote origin: ${fetchStderr}`))
    }
  }
}

/**
 * 确保当前分支已设置 upstream；若尚未设置且远程分支存在，
 * 则将其设为 origin/<branchName>。
 */
async function ensureUpstreamIsSet(branchName: string): Promise<void> {
  // 检查是否已设置 upstream。
  const { code: upstreamCheckCode } = await execFileNoThrow(gitExe(), [
    'rev-parse',
    '--abbrev-ref',
    `${branchName}@{upstream}`,
  ])
  if (upstreamCheckCode === 0) {
    // upstream 已设置。
    logForDebugging(`Branch '${branchName}' already has upstream set`)
    return
  }

  // 检查 origin/<branchName> 是否存在。
  const { code: remoteCheckCode } = await execFileNoThrow(gitExe(), [
    'rev-parse',
    '--verify',
    `origin/${branchName}`,
  ])
  if (remoteCheckCode === 0) {
    // 远程分支存在，设置 upstream。
    logForDebugging(`Setting upstream for '${branchName}' to 'origin/${branchName}'`)
    const { code: setUpstreamCode, stderr: setUpstreamStderr } = await execFileNoThrow(gitExe(), [
      'branch',
      '--set-upstream-to',
      `origin/${branchName}`,
      branchName,
    ])
    if (setUpstreamCode !== 0) {
      logForDebugging(`Failed to set upstream for '${branchName}': ${setUpstreamStderr}`)
      // 此错误并不关键，只记录日志而不继续抛出。
    } else {
      logForDebugging(`Successfully set upstream for '${branchName}'`)
    }
  } else {
    logForDebugging(`Remote branch 'origin/${branchName}' does not exist, skipping upstream setup`)
  }
}

/**
 * checkout 指定分支。
 */
async function checkoutBranch(branchName: string): Promise<void> {
  // 先按原名 checkout，该分支可能已存在于本地。
  let { code: checkoutCode, stderr: checkoutStderr } = await execFileNoThrow(gitExe(), [
    'checkout',
    branchName,
  ])

  // 失败时尝试从 origin checkout。
  if (checkoutCode !== 0) {
    logForDebugging(`Local checkout failed, trying to checkout from origin: ${checkoutStderr}`)

    // 尝试 checkout 远程分支并创建本地跟踪分支。
    const result = await execFileNoThrow(gitExe(), [
      'checkout',
      '-b',
      branchName,
      '--track',
      `origin/${branchName}`,
    ])
    checkoutCode = result.code
    checkoutStderr = result.stderr

    // 若仍失败，则尝试不带 -b，以处理分支已存在但未 checkout 的情况。
    if (checkoutCode !== 0) {
      logForDebugging(`Remote checkout with -b failed, trying without -b: ${checkoutStderr}`)
      const finalResult = await execFileNoThrow(gitExe(), [
        'checkout',
        '--track',
        `origin/${branchName}`,
      ])
      checkoutCode = finalResult.code
      checkoutStderr = finalResult.stderr
    }
  }
  if (checkoutCode !== 0) {
    logEvent('zy_teleport_error_branch_checkout_failed', {})
    throw new TeleportOperationError(
      `Failed to checkout branch '${branchName}': ${checkoutStderr}`,
      chalk.red(`Failed to checkout branch '${branchName}'\n`),
    )
  }

  // checkout 成功后确保 upstream 已设置。
  await ensureUpstreamIsSet(branchName)
}

/**
 * 获取当前分支名。
 */
async function getCurrentBranch(): Promise<string> {
  const { stdout: currentBranch } = await execFileNoThrow(gitExe(), ['branch', '--show-current'])
  return currentBranch.trim()
}

/**
 * 处理 teleport 恢复所需的消息：移除不完整的 tool_use 块，并添加 teleport 通知。
 * @param messages 会话消息
 * @param error checkout 分支时产生的可选错误
 * @returns 已处理、可用于恢复的消息
 */
export function processMessagesForTeleportResume(
  messages: Message[],
  error: Error | null,
): Message[] {
  // 与 resume 共用处理中断会话 transcript 的逻辑。
  const deserializedMessages = deserializeMessages(messages)

  // 添加模型可见的 teleport 恢复 user 消息。
  const messagesWithTeleportNotice = [
    ...deserializedMessages,
    createTeleportResumeUserMessage(),
    createTeleportResumeSystemMessage(error),
  ]
  return messagesWithTeleportNotice
}

/**
 * 为 teleport 会话 checkout 指定分支。
 * @param branch 要 checkout 的可选分支
 * @returns 当前分支名及发生的错误
 */
export async function checkOutTeleportedSessionBranch(branch?: string): Promise<{
  branchName: string
  branchError: Error | null
}> {
  try {
    const currentBranch = await getCurrentBranch()
    logForDebugging(`Current branch before teleport: '${currentBranch}'`)
    if (branch) {
      logForDebugging(`Switching to branch '${branch}'...`)
      await fetchFromOrigin(branch)
      await checkoutBranch(branch)
      const newBranch = await getCurrentBranch()
      logForDebugging(`Branch after checkout: '${newBranch}'`)
    } else {
      logForDebugging('No branch specified, staying on current branch')
    }
    const branchName = await getCurrentBranch()
    return {
      branchName,
      branchError: null,
    }
  } catch (error) {
    const branchName = await getCurrentBranch()
    const branchError = toError(error)
    return {
      branchName,
      branchError,
    }
  }
}

/**
 * teleport 仓库校验结果。
 */
export type RepoValidationResult = {
  status: 'match' | 'mismatch' | 'not_in_repo' | 'no_repo_required' | 'error'
  sessionRepo?: string
  currentRepo?: string | null
  /** 会话仓库的 host（如 "github.com" 或 "ghe.corp.com"），仅供展示。 */
  sessionHost?: string
  /** 当前仓库的 host（如 "github.com" 或 "ghe.corp.com"），仅供展示。 */
  currentHost?: string
  errorMessage?: string
}

/**
 * 校验当前仓库是否与会话仓库匹配。返回结果对象而非抛错，
 * 让调用方自行处理不匹配情况。
 *
 * @param sessionData 用于对照校验的会话资源
 * @returns 包含状态和仓库信息的校验结果
 */
export async function validateSessionRepository(
  sessionData: SessionResource,
): Promise<RepoValidationResult> {
  const currentParsed = await detectCurrentRepositoryWithHost()
  const currentRepo = currentParsed ? `${currentParsed.owner}/${currentParsed.name}` : null
  const gitSource = sessionData.session_context.sources.find(
    (source): source is GitSource => source.type === 'git_repository',
  )
  if (!gitSource?.url) {
    // 会话没有仓库要求。
    logForDebugging(
      currentRepo
        ? 'Session has no associated repository, proceeding without validation'
        : 'Session has no repo requirement and not in git directory, proceeding',
    )
    return {
      status: 'no_repo_required',
    }
  }
  const sessionParsed = parseGitRemote(gitSource.url)
  const sessionRepo = sessionParsed
    ? `${sessionParsed.owner}/${sessionParsed.name}`
    : parseGitHubRepository(gitSource.url)
  if (!sessionRepo) {
    return {
      status: 'no_repo_required',
    }
  }
  logForDebugging(
    `Session is for repository: ${sessionRepo}, current repo: ${currentRepo ?? 'none'}`,
  )
  if (!currentRepo) {
    // 当前不在 git 仓库中，但会话要求存在仓库。
    return {
      status: 'not_in_repo',
      sessionRepo,
      sessionHost: sessionParsed?.host,
      currentRepo: null,
    }
  }

  // 同时比较 owner/repo 与 host，避免跨实例误匹配。比较 host 前移除端口：
  // SSH remote 会省略端口，而 HTTPS remote 可能包含非标准端口
  //（如 ghe.corp.com:8443），直接比较会造成错误的不匹配结果。
  const stripPort = (host: string): string => host.replace(/:\d+$/, '')
  const repoMatch = currentRepo.toLowerCase() === sessionRepo.toLowerCase()
  const hostMatch =
    !currentParsed ||
    !sessionParsed ||
    stripPort(currentParsed.host.toLowerCase()) === stripPort(sessionParsed.host.toLowerCase())
  if (repoMatch && hostMatch) {
    return {
      status: 'match',
      sessionRepo,
      currentRepo,
    }
  }

  // 仓库不匹配：将 sessionRepo/currentRepo 保持为纯 "owner/repo"，供下游
  // consumer（如 getKnownPathsForRepo）作为查找键；host 信息另存字段供展示。
  return {
    status: 'mismatch',
    sessionRepo,
    currentRepo,
    sessionHost: sessionParsed?.host,
    currentHost: currentParsed?.host,
  }
}

/**
 * 根据 code session ID 执行 teleport。
 * 获取会话日志并校验仓库。
 * @param sessionId 要恢复的 session ID
 * @param onProgress 用于进度更新的可选 callback
 * @returns 原始会话日志和分支名
 */
export async function teleportResumeCodeSession(
  sessionId: string,
  onProgress?: TeleportProgressCallback,
): Promise<TeleportRemoteResponse> {
  if (!isPolicyAllowed('allow_remote_sessions')) {
    throw new Error("Remote sessions are disabled by your organization's policy.")
  }
  logForDebugging(`Resuming code session ID: ${sessionId}`)
  try {
    const accessToken = getZyAIOAuthTokens()?.accessToken
    if (!accessToken) {
      logEvent('zy_teleport_resume_error', {
        error_type: 'no_access_token' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      throw new Error(
        'ZY Code web sessions require authentication with a Zy.ai account. API key authentication is not sufficient. Please run /login to authenticate, or check your authentication status with /status.',
      )
    }

    // 获取组织 UUID。
    const orgUUID = await getOrganizationUUID()
    if (!orgUUID) {
      logEvent('zy_teleport_resume_error', {
        error_type: 'no_org_uuid' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      throw new Error('Unable to get organization UUID for constructing session URL')
    }

    // 恢复前获取并校验仓库是否匹配。
    onProgress?.('validating')
    const sessionData = await fetchSession(sessionId)
    const repoValidation = await validateSessionRepository(sessionData)
    switch (repoValidation.status) {
      case 'match':
      case 'no_repo_required':
        // 继续执行 teleport。
        break
      case 'not_in_repo': {
        logEvent('zy_teleport_error_repo_not_in_git_dir_sessions_api', {
          sessionId: sessionId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        // 为 GHE 用户包含 host，便于确认仓库所在实例。
        const notInRepoDisplay =
          repoValidation.sessionHost && repoValidation.sessionHost.toLowerCase() !== 'github.com'
            ? `${repoValidation.sessionHost}/${repoValidation.sessionRepo}`
            : repoValidation.sessionRepo
        throw new TeleportOperationError(
          `You must run zycode --teleport ${sessionId} from a checkout of ${notInRepoDisplay}.`,
          chalk.red(
            `You must run zycode --teleport ${sessionId} from a checkout of ${chalk.bold(notInRepoDisplay)}.\n`,
          ),
        )
      }
      case 'mismatch': {
        logEvent('zy_teleport_error_repo_mismatch_sessions_api', {
          sessionId: sessionId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
        // 仅当 host 确实不同时添加 host 前缀，以区分跨实例不匹配；
        // 同一 host 内的不匹配无需展示这一冗余信息。
        const hostsDiffer =
          repoValidation.sessionHost &&
          repoValidation.currentHost &&
          repoValidation.sessionHost.replace(/:\d+$/, '').toLowerCase() !==
            repoValidation.currentHost.replace(/:\d+$/, '').toLowerCase()
        const sessionDisplay = hostsDiffer
          ? `${repoValidation.sessionHost}/${repoValidation.sessionRepo}`
          : repoValidation.sessionRepo
        const currentDisplay = hostsDiffer
          ? `${repoValidation.currentHost}/${repoValidation.currentRepo}`
          : repoValidation.currentRepo
        throw new TeleportOperationError(
          `You must run zycode --teleport ${sessionId} from a checkout of ${sessionDisplay}.\nThis repo is ${currentDisplay}.`,
          chalk.red(
            `You must run zycode --teleport ${sessionId} from a checkout of ${chalk.bold(sessionDisplay)}.\nThis repo is ${chalk.bold(currentDisplay)}.\n`,
          ),
        )
      }
      case 'error':
        throw new TeleportOperationError(
          repoValidation.errorMessage || 'Failed to validate session repository',
          chalk.red(
            `Error: ${repoValidation.errorMessage || 'Failed to validate session repository'}\n`,
          ),
        )
      default: {
        const _exhaustive: never = repoValidation.status
        throw new Error(`Unhandled repo validation status: ${_exhaustive}`)
      }
    }
    return await teleportFromSessionsAPI(sessionId, orgUUID, accessToken, onProgress, sessionData)
  } catch (error) {
    if (error instanceof TeleportOperationError) {
      throw error
    }
    const err = toError(error)
    logError(err)
    logEvent('zy_teleport_resume_error', {
      error_type:
        'resume_session_id_catch' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    throw new TeleportOperationError(err.message, chalk.red(`Error: ${err.message}\n`))
  }
}

/**
 * 从 session ingress API（/v1/session_ingress/）获取会话数据。
 * 使用 session log 而非 SDK event，以取得正确的消息结构。
 * @param sessionId 要获取的 session ID
 * @param orgUUID 组织 UUID
 * @param accessToken OAuth access token
 * @param onProgress 用于进度更新的可选 callback
 * @param sessionData 可选会话数据，用于提取分支信息
 * @returns session log 为 Message[] 的 TeleportRemoteResponse
 */
export async function teleportFromSessionsAPI(
  sessionId: string,
  orgUUID: string,
  accessToken: string,
  onProgress?: TeleportProgressCallback,
  sessionData?: SessionResource,
): Promise<TeleportRemoteResponse> {
  const startTime = Date.now()
  try {
    // 通过 session ingress 获取会话日志。
    logForDebugging(`[teleport] Starting fetch for session: ${sessionId}`)
    onProgress?.('fetching_logs')
    const logsStartTime = Date.now()
    // 优先尝试 CCR v2（GetTeleportEvents，由服务器分派到 Spanner/threadstore）。
    // endpoint 尚未部署或发生临时错误而返回 null 时，退回 session-ingress。
    // 若 session-ingress 也已移除，fallback 将不起作用：getSessionLogsViaOAuth
    // 同样返回 null，最终以 “Failed to fetch session logs” 失败。
    let logs = await getTeleportEvents(sessionId, accessToken, orgUUID)
    if (logs === null) {
      logForDebugging('[teleport] v2 endpoint returned null, trying session-ingress')
      logs = await getSessionLogsViaOAuth(sessionId, accessToken, orgUUID)
    }
    logForDebugging(`[teleport] Session logs fetched in ${Date.now() - logsStartTime}ms`)
    if (logs === null) {
      throw new Error('Failed to fetch session logs')
    }

    // 仅保留 transcript 消息，排除 sidechain 消息。
    const filterStartTime = Date.now()
    const messages = logs.filter(
      (entry) => isTranscriptMessage(entry) && !entry.isSidechain,
    ) as Message[]
    logForDebugging(
      `[teleport] Filtered ${logs.length} entries to ${messages.length} messages in ${Date.now() - filterStartTime}ms`,
    )

    // 从会话数据中提取分支信息。
    onProgress?.('fetching_branch')
    const branch = sessionData ? getBranchFromSession(sessionData) : undefined
    if (branch) {
      logForDebugging(`[teleport] Found branch: ${branch}`)
    }
    logForDebugging(`[teleport] Total teleportFromSessionsAPI time: ${Date.now() - startTime}ms`)
    return {
      log: messages,
      branch,
    }
  } catch (error) {
    const err = toError(error)

    // 单独处理 404。
    if (axios.isAxiosError(error) && error.response?.status === 404) {
      logEvent('zy_teleport_error_session_not_found_404', {
        sessionId: sessionId as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      throw new TeleportOperationError(
        `${sessionId} not found.`,
        `${sessionId} not found.\n${chalk.dim('Run /status in ZY Code to check your account.')}`,
      )
    }
    logError(err)
    throw new Error(`Failed to fetch session from Sessions API: ${err.message}`)
  }
}

/**
 * 轮询远程会话事件的响应类型，采用 SDK event 格式。
 */
export type PollRemoteSessionResponse = {
  newEvents: WireMessage[]
  lastEventId: string | null
  branch?: string
  sessionStatus?: 'idle' | 'running' | 'requires_action' | 'archived'
}

/**
 * 轮询远程会话事件。将上次响应的 `lastEventId` 作为 `afterId` 传入即可只获取增量。
 * 不需要 branch/status 时设置 `skipMetadata`，避免每次调用
 * GET /v1/sessions/{id}。
 */
export async function pollRemoteSessionEvents(
  sessionId: string,
  afterId: string | null = null,
  opts?: {
    skipMetadata?: boolean
  },
): Promise<PollRemoteSessionResponse> {
  const accessToken = getZyAIOAuthTokens()?.accessToken
  if (!accessToken) {
    throw new Error('No access token for polling')
  }
  const orgUUID = await getOrganizationUUID()
  if (!orgUUID) {
    throw new Error('No org UUID for polling')
  }
  const headers = {
    ...getOAuthHeaders(accessToken),
    'anthropic-beta': 'ccr-byoc-2025-07-29',
    'x-organization-uuid': orgUUID,
  }
  const eventsUrl = `${getOauthConfig().BASE_API_URL}/v1/sessions/${sessionId}/events`
  type EventsResponse = {
    data: unknown[]
    has_more: boolean
    first_id: string | null
    last_id: string | null
  }

  // 此上限用于防止 cursor 卡住；稳定状态下通常只有 0–1 页。
  const MAX_EVENT_PAGES = 50
  const sdkMessages: WireMessage[] = []
  let cursor = afterId
  for (let page = 0; page < MAX_EVENT_PAGES; page++) {
    const eventsResponse = await axios.get(eventsUrl, {
      headers,
      params: cursor
        ? {
            after_id: cursor,
          }
        : undefined,
      timeout: 30000,
    })
    if (eventsResponse.status !== 200) {
      throw new Error(`Failed to fetch session events: ${eventsResponse.statusText}`)
    }
    const eventsData: EventsResponse = eventsResponse.data
    if (!eventsData?.data || !Array.isArray(eventsData.data)) {
      throw new Error('Invalid events response')
    }
    for (const event of eventsData.data) {
      if (event && typeof event === 'object' && 'type' in event) {
        if (event.type === 'env_manager_log' || event.type === 'control_response') {
          continue
        }
        if ('session_id' in event) {
          sdkMessages.push(event as WireMessage)
        }
      }
    }
    if (!eventsData.last_id) {
      break
    }
    cursor = eventsData.last_id
    if (!eventsData.has_more) {
      break
    }
  }
  if (opts?.skipMetadata) {
    return {
      newEvents: sdkMessages,
      lastEventId: cursor,
    }
  }

  // 获取会话元数据（branch、status）。
  let branch: string | undefined
  let sessionStatus: PollRemoteSessionResponse['sessionStatus']
  try {
    const sessionData = await fetchSession(sessionId)
    branch = getBranchFromSession(sessionData)
    sessionStatus = sessionData.session_status as PollRemoteSessionResponse['sessionStatus']
  } catch (e) {
    logForDebugging(`teleport: failed to fetch session ${sessionId} metadata: ${e}`, {
      level: 'debug',
    })
  }
  return {
    newEvents: sdkMessages,
    lastEventId: cursor,
    branch,
    sessionStatus,
  }
}

/**
 * 使用 Sessions API 创建远程 Zy.ai 会话。
 *
 * 两种源模式：
 * - GitHub（默认）：后端从仓库 origin URL 克隆。要求存在 GitHub remote 和 CCR 侧
 *   GitHub 连接。43% 的 CLI 会话有 origin remote，完整满足前置条件的比例更低。
 * - Bundle（CCR_FORCE_BUNDLE=1）：CLI 创建 `git bundle --all`，通过 Files API
 *   上传，并将 file_id 作为 session context 的 seed_bundle_file_id。CCR 下载后
 *   从 bundle 克隆，无需依赖 GitHub，适用于仅本地仓库；覆盖 54% 的 CLI 会话，
 *   即所有带 .git/ 的会话。
 *   Backend: anthropic#303856.
 */
export async function teleportToRemote(options: {
  initialMessage: string | null
  branchName?: string
  title?: string
  /**
   * 会话描述，用于生成标题和会话分支名，除非二者已显式提供。
   */
  description?: string
  model?: string
  permissionMode?: PermissionMode
  ultraplan?: boolean
  signal: AbortSignal
  useDefaultEnvironment?: boolean
  /**
   * 显式 environment_id，如 code_review 合成环境。绕过 fetchEnvironments；
   * 常规的仓库检测 → git source 仍会运行，使容器 checkout 仓库；orchestrator
   * 从 pwd 读取 --repo-dir，并不执行 clone。
   */
  environmentId?: string
  /**
   * 合并到 session_context.environment_variables 的每会话环境变量。在 API 层
   * 只写，Get/List 响应会移除。设置 environmentId 时，会从调用方 accessToken
   * 自动注入 ZY_CODE_OAUTH_TOKEN，使容器 hook 可调用 inference；服务器只透传
   * 调用方所发内容，bughunter.go 会自行签发，用户会话不会自动取得。
   */
  environmentVariables?: Record<string, string>
  /**
   * 与 environmentId 一同设置时，创建并上传本地工作树的 git bundle；
   * createAndUploadGitBundle 会通过 stash-create 处理未提交变更，并将结果作为
   * seed_bundle_file_id。后端从 bundle 而非 GitHub 克隆，使容器得到调用方的精确
   * 本地状态。仅要求 .git/，无需 GitHub remote。
   */
  useBundle?: boolean
  /**
   * 尝试 bundle 路径但失败时，以用户可见消息调用。wrapper 在 REPL 前写入 stderr；
   * remote-agent 调用方会捕获并加入抛错，在 REPL 内由 Ink 渲染。
   */
  onBundleFail?: (message: string) => void
  /**
   * 为 true 时完全禁用 git-bundle fallback。适用于 autofix 等 CCR 必须推送到
   * GitHub 的流程，因为 bundle 无法完成推送。
   */
  skipBundle?: boolean
  /**
   * 设置后复用此分支作为 outcome branch，不再生成新 zy/ 分支。同时在 source
   * 设置 allow_unrestricted_git_push，并在 session context 设置
   * reuse_outcome_branches，使远程端直接推送到调用方分支。
   */
  reuseOutcomeBranch?: string
  /**
   * 附加到 session context 的 GitHub PR；后端据此识别与会话关联的 PR。
   */
  githubPr?: {
    owner: string
    repo: string
    number: number
  }
}): Promise<TeleportToRemoteResponse | null> {
  const { initialMessage, signal } = options
  try {
    // 检查鉴权。
    await checkAndRefreshOAuthTokenIfNeeded()
    const accessToken = getZyAIOAuthTokens()?.accessToken
    if (!accessToken) {
      logError(new Error('No access token found for remote session creation'))
      return null
    }

    // 获取组织 UUID。
    const orgUUID = await getOrganizationUUID()
    if (!orgUUID) {
      logError(new Error('Unable to get organization UUID for remote session creation'))
      return null
    }

    // 显式 environmentId 会跳过 Haiku 标题生成和环境选择，但仍执行仓库检测，
    // 使容器取得工作目录。code_review orchestrator 读取 --repo-dir $(pwd)，不执行
    // clone；bughunter.go:520 也会设置 git source，env-manager 在 SessionStart hook
    // 触发前完成 checkout。
    if (options.environmentId) {
      const url = `${getOauthConfig().BASE_API_URL}/v1/sessions`
      const headers = {
        ...getOAuthHeaders(accessToken),
        'anthropic-beta': 'ccr-byoc-2025-07-29',
        'x-organization-uuid': orgUUID,
      }
      const envVars = {
        ZY_CODE_OAUTH_TOKEN: accessToken,
        ...(options.environmentVariables ?? {}),
      }

      // Bundle 模式上传本地工作树，未提交变更通过 refs/seed/stash 携带，容器从
      // bundle 克隆，无需 GitHub。否则使用 github.com source，调用方已检查资格。
      let gitSource: GitSource | null = null
      let seedBundleFileId: string | null = null
      if (options.useBundle) {
        const bundle = await createAndUploadGitBundle(
          {
            oauthToken: accessToken,
            sessionId: getSessionId(),
            baseUrl: getOauthConfig().BASE_API_URL,
          },
          {
            signal,
          },
        )
        if (!bundle.success) {
          logError(new Error(`Bundle upload failed: ${bundle.error}`))
          return null
        }
        seedBundleFileId = bundle.fileId
        logEvent('zy_teleport_bundle_mode', {
          size_bytes: bundle.bundleSizeBytes,
          scope: bundle.scope as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
          has_wip: bundle.hasWip,
          reason:
            'explicit_env_bundle' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        })
      } else {
        const repoInfo = await detectCurrentRepositoryWithHost()
        if (repoInfo) {
          gitSource = {
            type: 'git_repository',
            url: `https://${repoInfo.host}/${repoInfo.owner}/${repoInfo.name}`,
            revision: options.branchName,
          }
        }
      }
      const requestBody = {
        title: options.title || options.description || 'Remote task',
        events: [],
        session_context: {
          sources: gitSource ? [gitSource] : [],
          ...(seedBundleFileId && {
            seed_bundle_file_id: seedBundleFileId,
          }),
          outcomes: [],
          environment_variables: envVars,
        },
        environment_id: options.environmentId,
      }
      logForDebugging(
        `[teleportToRemote] explicit env ${options.environmentId}, ${Object.keys(envVars).length} env vars, ${seedBundleFileId ? `bundle=${seedBundleFileId}` : `source=${gitSource?.url ?? 'none'}@${options.branchName ?? 'default'}`}`,
      )
      const response = await axios.post(url, requestBody, {
        headers,
        signal,
      })
      if (response.status !== 200 && response.status !== 201) {
        logError(new Error(`CreateSession ${response.status}: ${jsonStringify(response.data)}`))
        return null
      }
      const sessionData = response.data as SessionResource
      if (!sessionData || typeof sessionData.id !== 'string') {
        logError(new Error(`No session id in response: ${jsonStringify(response.data)}`))
        return null
      }
      return {
        id: sessionData.id,
        title: sessionData.title || requestBody.title,
      }
    }
    let gitSource: GitSource | null = null
    let gitOutcome: GitRepositoryOutcome | null = null
    let seedBundleFileId: string | null = null

    // 源选择顺序：CCR 确实可拉取时用 GitHub clone；存在 .git 时退回 bundle；
    // 最后使用空 sandbox。
    //
    // preflight 与容器 git-proxy clone 命中的代码路径相同
    //（get_github_client_with_user_auth → no_sync_user_token_found）。到达
    // “install GitHub App”步骤的用户有 50% 未完成；没有 preflight 时，这些用户
    // 都会取得 clone 时返回 401 的容器；加入后会静默退回 bundle。
    //
    // CCR_FORCE_BUNDLE=1 完全跳过 preflight，适用于测试或明确知道 GitHub 鉴权损坏
    // 的情况。在此处而非调用方读取，使其也适用于 remote-agent，而不只适用于 --remote。

    const repoInfo = await detectCurrentRepositoryWithHost()

    // 为会话生成标题和分支名；标题与 outcome branch 均显式提供时跳过 Haiku 调用。
    let sessionTitle: string
    let sessionBranch: string
    if (options.title && options.reuseOutcomeBranch) {
      sessionTitle = options.title
      sessionBranch = options.reuseOutcomeBranch
    } else {
      const generated = await generateTitleAndBranch(
        options.description || initialMessage || 'Background task',
        signal,
      )
      sessionTitle = options.title || generated.title
      sessionBranch = options.reuseOutcomeBranch || generated.branchName
    }

    // preflight 检查 CCR 是否有可克隆此仓库的 token。仅检查 github.com；GHES
    // 需要当前没有的 ghe_configuration_id，且其用户通常已完成设置。对 GHES 以及
    // parseGitRemote 意外接受的非 GitHub host 乐观放行；后端拒绝 host 时下次用 bundle。
    let ghViable = false
    let sourceReason:
      | 'github_preflight_ok'
      | 'ghes_optimistic'
      | 'github_preflight_failed'
      | 'no_github_remote'
      | 'forced_bundle'
      | 'no_git_at_all' = 'no_git_at_all'

    // gitRoot 同时控制 bundle 创建和 gate 检查；无内容可打包时无需等待 GrowthBook。
    const gitRoot = findGitRoot(getCwd())
    const forceBundle = !options.skipBundle && isEnvTruthy(process.env.CCR_FORCE_BUNDLE)
    const bundleSeedGateOn =
      !options.skipBundle &&
      gitRoot !== null &&
      (isEnvTruthy(process.env.CCR_ENABLE_BUNDLE) ||
        (await checkGate_CACHED_OR_BLOCKING('zy_ccr_bundle_seed')))
    if (repoInfo && !forceBundle) {
      if (repoInfo.host === 'github.com') {
        ghViable = await checkGithubAppInstalled(repoInfo.owner, repoInfo.name, signal)
        sourceReason = ghViable ? 'github_preflight_ok' : 'github_preflight_failed'
      } else {
        ghViable = true
        sourceReason = 'ghes_optimistic'
      }
    } else if (forceBundle) {
      sourceReason = 'forced_bundle'
    } else if (gitRoot) {
      sourceReason = 'no_github_remote'
    }

    // preflight 失败但 bundle 已关闭时，按引入 preflight 前的行为乐观放行，
    // 由后端报告真实鉴权错误。
    if (!ghViable && !bundleSeedGateOn && repoInfo) {
      ghViable = true
    }
    if (ghViable && repoInfo) {
      const { host, owner, name } = repoInfo
      // 解析基础分支：优先采用显式 branchName，否则退回默认分支。
      const revision = options.branchName ?? (await getDefaultBranch()) ?? undefined
      logForDebugging(
        `[teleportToRemote] Git source: ${host}/${owner}/${name}, revision: ${revision ?? 'none'}`,
      )
      gitSource = {
        type: 'git_repository',
        url: `https://${host}/${owner}/${name}`,
        // revision 指定要作为基础分支 checkout 的 ref。
        revision,
        ...(options.reuseOutcomeBranch && {
          allow_unrestricted_git_push: true,
        }),
      }
      // 所有兼容 GitHub 的 host（github.com 与 GHE）均使用 type: 'github'。
      // CLI 客户端无法区分 GHE 与 GitLab、Bitbucket 等非 GitHub host；后端会按已配置
      // GHE 实例校验 URL，并忽略无法识别 host 的 git_info。
      gitOutcome = {
        type: 'git_repository',
        git_info: {
          type: 'github',
          repo: `${owner}/${name}`,
          branches: [sessionBranch],
        },
      }
    }

    // Bundle fallback：仅在 GitHub 不可用、gate 已开启且存在可打包的 .git/ 时尝试。
    // 到达此处且 ghViable=false、repoInfo 非 null 表示 preflight 失败；.git 必然存在，
    // 因为 detectCurrentRepositoryWithHost 已从中读取 remote。
    if (!gitSource && bundleSeedGateOn) {
      logForDebugging(`[teleportToRemote] Bundling (reason: ${sourceReason})`)
      const bundle = await createAndUploadGitBundle(
        {
          oauthToken: accessToken,
          sessionId: getSessionId(),
          baseUrl: getOauthConfig().BASE_API_URL,
        },
        {
          signal,
        },
      )
      if (!bundle.success) {
        logError(new Error(`Bundle upload failed: ${bundle.error}`))
        // 仅在存在可克隆 remote 时引导用户设置 GitHub。
        const setup = repoInfo ? '. Please setup GitHub on https://zy.ai/code' : ''
        let msg: string
        switch (bundle.failReason) {
          case 'empty_repo':
            msg =
              'Repository has no commits — run `git add . && git commit -m "initial"` then retry'
            break
          case 'too_large':
            msg = `Repo is too large to teleport${setup}`
            break
          case 'git_error':
            msg = `Failed to create git bundle (${bundle.error})${setup}`
            break
          case undefined:
            msg = `Bundle upload failed: ${bundle.error}${setup}`
            break
          default: {
            const _exhaustive: 'git_error' | 'too_large' | 'empty_repo' | undefined =
              bundle.failReason
            void _exhaustive
            msg = `Bundle upload failed: ${bundle.error}`
          }
        }
        options.onBundleFail?.(msg)
        return null
      }
      seedBundleFileId = bundle.fileId
      logEvent('zy_teleport_bundle_mode', {
        size_bytes: bundle.bundleSizeBytes,
        scope: bundle.scope as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        has_wip: bundle.hasWip,
        reason: sourceReason as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
    }
    logEvent('zy_teleport_source_decision', {
      reason: sourceReason as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      path: (gitSource
        ? 'github'
        : seedBundleFileId
          ? 'bundle'
          : 'empty') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    if (!gitSource && !seedBundleFileId) {
      logForDebugging(
        '[teleportToRemote] No repository detected — session will have an empty sandbox',
      )
    }

    // 获取可用环境。
    let environments = await fetchEnvironments()
    if (!environments || environments.length === 0) {
      logError(new Error('No environments available for session creation'))
      return null
    }
    logForDebugging(
      `Available environments: ${environments.map((e) => `${e.environment_id} (${e.name}, ${e.kind})`).join(', ')}`,
    )

    // 按设置选择环境，其次优先 anthropic_cloud，最后选择首个可用项。
    // anthropic_cloud 环境（如 “Default”）是具有完整仓库访问权的标准计算环境；
    // byoc 环境（如 “monorepo”）由用户拥有，可能不支持当前仓库，因此前者优先。
    const settings = getInitialSettings()
    const defaultEnvironmentId = options.useDefaultEnvironment
      ? undefined
      : settings?.remote?.defaultEnvironmentId
    let cloudEnv = environments.find((env) => env.kind === 'anthropic_cloud')
    // 调用方选择不使用配置的默认环境时，不要退回可能不支持当前仓库或所请求权限
    // 模式的 BYOC 环境。为最终一致性重试一次，仍失败则显式报错。
    if (options.useDefaultEnvironment && !cloudEnv) {
      logForDebugging(
        `No anthropic_cloud in env list (${environments.length} envs); retrying fetchEnvironments`,
      )
      const retried = await fetchEnvironments()
      cloudEnv = retried?.find((env) => env.kind === 'anthropic_cloud')
      if (!cloudEnv) {
        logError(
          new Error(
            `No anthropic_cloud environment available after retry (got: ${(retried ?? environments).map((e) => `${e.name} (${e.kind})`).join(', ')}). Silent byoc fallthrough would launch into a dead env — fail fast instead.`,
          ),
        )
        return null
      }
      if (retried) {
        environments = retried
      }
    }
    const selectedEnvironment =
      (defaultEnvironmentId &&
        environments.find((env) => env.environment_id === defaultEnvironmentId)) ||
      cloudEnv ||
      environments.find((env) => env.kind !== 'bridge') ||
      environments[0]
    if (!selectedEnvironment) {
      logError(new Error('No environments available for session creation'))
      return null
    }
    if (defaultEnvironmentId) {
      const matchedDefault = selectedEnvironment.environment_id === defaultEnvironmentId
      logForDebugging(
        matchedDefault
          ? `Using configured default environment: ${defaultEnvironmentId}`
          : `Configured default environment ${defaultEnvironmentId} not found, using first available`,
      )
    }
    const environmentId = selectedEnvironment.environment_id
    logForDebugging(
      `Selected environment: ${environmentId} (${selectedEnvironment.name}, ${selectedEnvironment.kind})`,
    )

    // 准备 Sessions API 请求。
    const url = `${getOauthConfig().BASE_API_URL}/v1/sessions`
    const headers = {
      ...getOAuthHeaders(accessToken),
      'anthropic-beta': 'ccr-byoc-2025-07-29',
      'x-organization-uuid': orgUUID,
    }
    const sessionContext = {
      sources: gitSource ? [gitSource] : [],
      ...(seedBundleFileId && {
        seed_bundle_file_id: seedBundleFileId,
      }),
      outcomes: gitOutcome ? [gitOutcome] : [],
      model: options.model ?? getMainLoopModel(),
      ...(options.reuseOutcomeBranch && {
        reuse_outcome_branches: true,
      }),
      ...(options.githubPr && {
        github_pr: options.githubPr,
      }),
    }

    // CreateCCRSessionPayload 没有 permission_mode 字段，顶层 body 条目会被服务端
    // proto parser 静默丢弃。因此在前方加入 set_permission_mode control_request
    // event。容器连接前 initial event 已写入 threadstore，CLI 会在首个用户轮次前
    // 应用模式，不存在就绪竞态。
    const events: Array<{
      type: 'event'
      data: Record<string, unknown>
    }> = []
    if (options.permissionMode) {
      events.push({
        type: 'event',
        data: {
          type: 'control_request',
          request_id: `set-mode-${randomUUID()}`,
          request: {
            subtype: 'set_permission_mode',
            mode: options.permissionMode,
            ultraplan: options.ultraplan,
          },
        },
      })
    }
    if (initialMessage) {
      events.push({
        type: 'event',
        data: {
          uuid: randomUUID(),
          session_id: '',
          type: 'user',
          parent_tool_use_id: null,
          message: {
            role: 'user',
            content: initialMessage,
          },
        },
      })
    }
    const requestBody = {
      title: options.ultraplan ? `ultraplan: ${sessionTitle}` : sessionTitle,
      events,
      session_context: sessionContext,
      environment_id: environmentId,
    }
    logForDebugging(`Creating session with payload: ${jsonStringify(requestBody, null, 2)}`)

    // 调用 API。
    const response = await axios.post(url, requestBody, {
      headers,
      signal,
    })
    const isSuccess = response.status === 200 || response.status === 201
    if (!isSuccess) {
      logError(
        new Error(
          `API request failed with status ${response.status}: ${response.statusText}\n\nResponse data: ${jsonStringify(response.data, null, 2)}`,
        ),
      )
      return null
    }

    // 将响应解析为 SessionResource。
    const sessionData = response.data as SessionResource
    if (!sessionData || typeof sessionData.id !== 'string') {
      logError(
        new Error(`Cannot determine session ID from API response: ${jsonStringify(response.data)}`),
      )
      return null
    }
    logForDebugging(`Successfully created remote session: ${sessionData.id}`)
    return {
      id: sessionData.id,
      title: sessionData.title || requestBody.title,
    }
  } catch (error) {
    const err = toError(error)
    logError(err)
    return null
  }
}

/**
 * 尽力归档会话。POST /v1/sessions/{id}/archive 不检查运行状态，不像 DELETE 会对
 * RUNNING 返回 409，因此可在实现过程中调用。已归档会话拒绝新事件
 *（send_events.go），远程端会在下次写入时停止。409 表示已归档，按成功处理。
 * 此操作 fire-and-forget；失败会留下可见会话，直至 reaper 回收。
 */
export async function archiveRemoteSession(sessionId: string): Promise<void> {
  const accessToken = getZyAIOAuthTokens()?.accessToken
  if (!accessToken) {
    return
  }
  const orgUUID = await getOrganizationUUID()
  if (!orgUUID) {
    return
  }
  const headers = {
    ...getOAuthHeaders(accessToken),
    'anthropic-beta': 'ccr-byoc-2025-07-29',
    'x-organization-uuid': orgUUID,
  }
  const url = `${getOauthConfig().BASE_API_URL}/v1/sessions/${sessionId}/archive`
  try {
    const resp = await axios.post(
      url,
      {},
      {
        headers,
        timeout: 10000,
        validateStatus: (s) => s < 500,
      },
    )
    if (resp.status === 200 || resp.status === 409) {
      logForDebugging(`[archiveRemoteSession] archived ${sessionId}`)
    } else {
      logForDebugging(
        `[archiveRemoteSession] ${sessionId} failed ${resp.status}: ${jsonStringify(resp.data)}`,
      )
    }
  } catch (err) {
    logError(err)
  }
}
