import { randomUUID } from 'node:crypto'
import { useCallback, useEffect, useRef } from 'react'
import { useInterval } from 'usehooks-ts'
import type { ToolUseConfirm } from '../components/permissions/PermissionRequest.js'
import { TEAMMATE_MESSAGE_TAG } from '../constants/xml.js'
import { useTerminalNotification } from '../ink/useTerminalNotification.js'
import { sendNotification } from '../services/notifier.js'
import { isInsideTmux } from '../services/swarm/backends/detection.js'
import { ensureBackendsRegistered, getBackendByType } from '../services/swarm/backends/registry.js'
import type { PaneBackendType } from '../services/swarm/backends/types.js'
import { TEAM_LEAD_NAME } from '../services/swarm/constants.js'
import { getLeaderToolUseConfirmQueue } from '../services/swarm/leaderPermissionBridge.js'
import { sendPermissionResponseViaMailbox } from '../services/swarm/permissionSync.js'
import { removeTeammateFromTeamFile, setMemberMode } from '../services/swarm/teamHelpers.js'
import type { AppState } from '../state/AppStateStore.js'
import { useAppState, useAppStateStore, useSetAppState } from '../state/AppState.js'
import { findToolByName } from '../tools/tool.js'
import { isInProcessTeammateTask } from '../tasks/in-process-teammate-task/types.js'
import { getAllBaseTools } from '../tools/tools.js'
import type { PermissionUpdate } from '../types/permissions.js'
import { logForDebugging } from '../services/infra/debug.js'
import {
  findInProcessTeammateTaskId,
  handlePlanApprovalResponse,
} from '../services/swarm/inProcessTeammateHelpers.js'
import { createAssistantMessage } from '../services/messages/./constructors.js'
import {
  permissionModeFromString,
  toExternalPermissionMode,
} from '../services/permissions/permissionMode.js'
import { applyPermissionUpdate } from '../services/permissions/permissionUpdate.js'
import { jsonStringify } from '../services/infra/slowOperations.js'
import { unassignTeammateTasks } from '../services/tasks-service/tasks.js'
import {
  getAgentName,
  isPlanModeRequired,
  isTeamLead,
  isTeammate,
} from '../services/swarm/teammate.js'
import { isInProcessTeammate } from '../services/swarm/teammateContext.js'
import {
  isModeSetRequest,
  isPermissionRequest,
  isPermissionResponse,
  isPlanApprovalRequest,
  isPlanApprovalResponse,
  isSandboxPermissionRequest,
  isSandboxPermissionResponse,
  isShutdownApproved,
  isShutdownRequest,
  isTeamPermissionUpdate,
  type TeammateMessage,
} from '../services/swarm/teammateMailboxMessages.js'
import {
  markMessagesAsRead,
  readUnreadMessages,
  writeToMailbox,
} from '../services/swarm/teammateMailbox.js'
import {
  hasPermissionCallback,
  hasSandboxPermissionCallback,
  processMailboxPermissionResponse,
  processSandboxPermissionResponse,
} from './useSwarmPermissionPoller.js'

/**
 * 获取用于轮询消息的 agent 名称。
 * - 进程内 teammate 返回 undefined（改用 waitForNextPromptOrShutdown）
 * - 基于进程的 teammate 使用其 ZY_CODE_AGENT_NAME
 * - team lead 使用 teamContext.teammates 中的名称
 * - 独立会话返回 undefined
 */
function getAgentNameToPoll(appState: AppState): string | undefined {
  // In-process teammates should NOT use useInboxPoller - they have their own
  // polling mechanism via waitForNextPromptOrShutdown() in inProcessRunner.ts.
  // Using useInboxPoller would cause message routing issues since in-process
  // teammates share the same React context and AppState with the leader.
  //
  // Note: This can be called when the leader's REPL re-renders while an
  // in-process teammate's AsyncLocalStorage context is active (due to shared
  // setAppState). We return undefined to gracefully skip polling rather than
  // throwing, since this is a normal occurrence during concurrent execution.
  if (isInProcessTeammate()) {
    return undefined
  }
  if (isTeammate()) {
    return getAgentName()
  }
  // team lead 使用 agent 名称而非 ID 轮询
  if (isTeamLead(appState.teamContext)) {
    const leadAgentId = appState.teamContext!.leadAgentId
    // 从 teammates map 查找 lead 名称
    const leadName = appState.teamContext!.teammates[leadAgentId]?.name
    return leadName || 'team-lead'
  }
  return undefined
}

const INBOX_POLL_INTERVAL_MS = 1000

type Props = {
  enabled: boolean
  isLoading: boolean
  focusedInputDialog: string | undefined
  // 提交成功返回 true，被拒绝（如 query 已在运行）时返回 false
  // dead code elimination：参数命名为 onSubmitMessage，避免外部构建中出现 "teammate" 字符串
  onSubmitMessage: (formatted: string) => boolean
}

/**
 * 轮询 teammate inbox 中的新消息，并将其作为轮次提交。
 *
 * 此 hook：
 * 1. 每秒轮询 teammate 或 team lead 的未读消息
 * 2. 空闲时立即将消息作为新轮次提交
 * 3. 忙碌时将消息放入 AppState.inbox 供 UI 显示，并在轮次结束后投递
 */
export function useInboxPoller({
  enabled,
  isLoading,
  focusedInputDialog,
  onSubmitMessage,
}: Props): void {
  // 赋给原名称，使函数内部语义更清晰
  const onSubmitTeammateMessage = onSubmitMessage
  const store = useAppStateStore()
  const setAppState = useSetAppState()
  const _inboxMessageCount = useAppState((s) => s.inbox.messages.length)
  const terminal = useTerminalNotification()

  const poll = useCallback(async () => {
    if (!enabled) {
      return
    }

    // 使用 ref 避免依赖 appState 对象，防止无限循环
    const currentAppState = store.getState()
    const agentName = getAgentNameToPoll(currentAppState)
    if (!agentName) {
      return
    }

    const unread = await readUnreadMessages(agentName, currentAppState.teamContext?.teamName)

    if (unread.length === 0) {
      return
    }

    logForDebugging(`[InboxPoller] Found ${unread.length} unread message(s)`)

    // 检查 plan approval 响应；获批后退出 plan 模式
    // 安全要求：只接受 team lead 的 approval 响应
    if (isTeammate() && isPlanModeRequired()) {
      for (const msg of unread) {
        const approvalResponse = isPlanApprovalResponse(msg.text)
        // Verify the message is from the team lead to prevent teammates from forging approvals
        if (approvalResponse && msg.from === 'team-lead') {
          logForDebugging(
            `[InboxPoller] Received plan approval response from team-lead: approved=${approvalResponse.approved}`,
          )
          if (approvalResponse.approved) {
            // Use leader's permission mode if provided, otherwise default
            const targetMode = approvalResponse.permissionMode ?? 'default'

            // Transition out of plan mode
            setAppState((prev) => ({
              ...prev,
              toolPermissionContext: applyPermissionUpdate(prev.toolPermissionContext, {
                type: 'setMode',
                mode: toExternalPermissionMode(targetMode),
                destination: 'session',
              }),
            }))
            logForDebugging(
              `[InboxPoller] Plan approved by team lead, exited plan mode to ${targetMode}`,
            )
          } else {
            logForDebugging(
              `[InboxPoller] Plan rejected by team lead: ${approvalResponse.feedback || 'No feedback provided'}`,
            )
          }
        } else if (approvalResponse) {
          logForDebugging(
            `[InboxPoller] Ignoring plan approval response from non-team-lead: ${msg.from}`,
          )
        }
      }
    }

    // 在 inbox 文件中将消息标记为已读的辅助函数。
    // 消息成功投递或可靠入队后调用。
    const markRead = () => {
      void markMessagesAsRead(agentName, currentAppState.teamContext?.teamName)
    }

    // 将权限消息与普通 teammate 消息分开
    const permissionRequests: TeammateMessage[] = []
    const permissionResponses: TeammateMessage[] = []
    const sandboxPermissionRequests: TeammateMessage[] = []
    const sandboxPermissionResponses: TeammateMessage[] = []
    const shutdownRequests: TeammateMessage[] = []
    const shutdownApprovals: TeammateMessage[] = []
    const teamPermissionUpdates: TeammateMessage[] = []
    const modeSetRequests: TeammateMessage[] = []
    const planApprovalRequests: TeammateMessage[] = []
    const regularMessages: TeammateMessage[] = []

    for (const m of unread) {
      const permReq = isPermissionRequest(m.text)
      const permResp = isPermissionResponse(m.text)
      const sandboxReq = isSandboxPermissionRequest(m.text)
      const sandboxResp = isSandboxPermissionResponse(m.text)
      const shutdownReq = isShutdownRequest(m.text)
      const shutdownApproval = isShutdownApproved(m.text)
      const teamPermUpdate = isTeamPermissionUpdate(m.text)
      const modeSetReq = isModeSetRequest(m.text)
      const planApprovalReq = isPlanApprovalRequest(m.text)

      if (permReq) {
        permissionRequests.push(m)
      } else if (permResp) {
        permissionResponses.push(m)
      } else if (sandboxReq) {
        sandboxPermissionRequests.push(m)
      } else if (sandboxResp) {
        sandboxPermissionResponses.push(m)
      } else if (shutdownReq) {
        shutdownRequests.push(m)
      } else if (shutdownApproval) {
        shutdownApprovals.push(m)
      } else if (teamPermUpdate) {
        teamPermissionUpdates.push(m)
      } else if (modeSetReq) {
        modeSetRequests.push(m)
      } else if (planApprovalReq) {
        planApprovalRequests.push(m)
      } else {
        regularMessages.push(m)
      }
    }

    // 处理权限请求（leader 侧），路由到 ToolUseConfirmQueue
    if (permissionRequests.length > 0 && isTeamLead(currentAppState.teamContext)) {
      logForDebugging(`[InboxPoller] Found ${permissionRequests.length} permission request(s)`)

      const setToolUseConfirmQueue = getLeaderToolUseConfirmQueue()
      const teamName = currentAppState.teamContext?.teamName

      for (const m of permissionRequests) {
        const parsed = isPermissionRequest(m.text)
        if (!parsed) {
          continue
        }

        if (setToolUseConfirmQueue) {
          // Route through the standard ToolUseConfirmQueue so tmux workers
          // get the same tool-specific UI (BashPermissionRequest, FileEditToolDiff, etc.)
          // as in-process teammates.
          const tool = findToolByName(getAllBaseTools(), parsed.tool_name)
          if (!tool) {
            logForDebugging(
              `[InboxPoller] Unknown tool ${parsed.tool_name}, skipping permission request`,
            )
            continue
          }

          const entry: ToolUseConfirm = {
            assistantMessage: createAssistantMessage({ content: '' }),
            tool,
            description: parsed.description,
            input: parsed.input,
            toolUseContext: {} as ToolUseConfirm['toolUseContext'],
            toolUseID: parsed.toolCallId,
            permissionResult: {
              behavior: 'ask',
              message: parsed.description,
            },
            permissionPromptStartTimeMs: Date.now(),
            workerBadge: {
              name: parsed.agent_id,
              color: 'cyan',
            },
            onUserInteraction() {
              // tmux worker 无需处理（没有 classifier 自动批准）
            },
            onAbort() {
              void sendPermissionResponseViaMailbox(
                parsed.agent_id,
                { decision: 'rejected', resolvedBy: 'leader' },
                parsed.request_id,
                teamName,
              )
            },
            onAllow(updatedInput: Record<string, unknown>, permissionUpdates: PermissionUpdate[]) {
              void sendPermissionResponseViaMailbox(
                parsed.agent_id,
                {
                  decision: 'approved',
                  resolvedBy: 'leader',
                  updatedInput,
                  permissionUpdates,
                },
                parsed.request_id,
                teamName,
              )
            },
            onReject(feedback?: string) {
              void sendPermissionResponseViaMailbox(
                parsed.agent_id,
                {
                  decision: 'rejected',
                  resolvedBy: 'leader',
                  feedback,
                },
                parsed.request_id,
                teamName,
              )
            },
            async recheckPermission() {
              // tmux worker 无需处理，权限状态位于 worker 侧
            },
          }

          // Deduplicate: if markMessagesAsRead failed on a prior poll,
          // the same message will be re-read — skip if already queued.
          setToolUseConfirmQueue((queue) => {
            if (queue.some((q) => q.toolUseID === parsed.toolCallId)) {
              return queue
            }
            return [...queue, entry]
          })
        } else {
          logForDebugging(
            `[InboxPoller] ToolUseConfirmQueue unavailable, dropping permission request from ${parsed.agent_id}`,
          )
        }
      }

      // 为首个请求发送桌面通知
      const firstParsed = isPermissionRequest(permissionRequests[0]?.text ?? '')
      if (firstParsed && !isLoading && !focusedInputDialog) {
        void sendNotification(
          {
            message: `${firstParsed.agent_id} needs permission for ${firstParsed.tool_name}`,
            notificationType: 'worker_permission_prompt',
          },
          terminal,
        )
      }
    }

    // 处理权限响应（worker 侧），调用已注册 callback
    if (permissionResponses.length > 0 && isTeammate()) {
      logForDebugging(`[InboxPoller] Found ${permissionResponses.length} permission response(s)`)

      for (const m of permissionResponses) {
        const parsed = isPermissionResponse(m.text)
        if (!parsed) {
          continue
        }

        if (hasPermissionCallback(parsed.request_id)) {
          logForDebugging(
            `[InboxPoller] Processing permission response for ${parsed.request_id}: ${parsed.subtype}`,
          )

          if (parsed.subtype === 'success') {
            processMailboxPermissionResponse({
              requestId: parsed.request_id,
              decision: 'approved',
              updatedInput: parsed.response?.updated_input,
              permissionUpdates: parsed.response?.permission_updates,
            })
          } else {
            processMailboxPermissionResponse({
              requestId: parsed.request_id,
              decision: 'rejected',
              feedback: parsed.error,
            })
          }
        }
      }
    }

    // 处理 sandbox 权限请求（leader 侧），加入 workerSandboxPermissions 队列
    if (sandboxPermissionRequests.length > 0 && isTeamLead(currentAppState.teamContext)) {
      logForDebugging(
        `[InboxPoller] Found ${sandboxPermissionRequests.length} sandbox permission request(s)`,
      )

      const newSandboxRequests: Array<{
        requestId: string
        workerId: string
        workerName: string
        workerColor?: string
        host: string
        createdAt: number
      }> = []

      for (const m of sandboxPermissionRequests) {
        const parsed = isSandboxPermissionRequest(m.text)
        if (!parsed) {
          continue
        }

        // 校验必需的嵌套字段，避免畸形消息导致崩溃
        if (!parsed.hostPattern?.host) {
          logForDebugging(
            `[InboxPoller] Invalid sandbox permission request: missing hostPattern.host`,
          )
          continue
        }

        newSandboxRequests.push({
          requestId: parsed.requestId,
          workerId: parsed.workerId,
          workerName: parsed.workerName,
          workerColor: parsed.workerColor,
          host: parsed.hostPattern.host,
          createdAt: parsed.createdAt,
        })
      }

      if (newSandboxRequests.length > 0) {
        setAppState((prev) => ({
          ...prev,
          workerSandboxPermissions: {
            ...prev.workerSandboxPermissions,
            queue: [...prev.workerSandboxPermissions.queue, ...newSandboxRequests],
          },
        }))

        // 为首个新请求发送桌面通知
        const firstRequest = newSandboxRequests[0]
        if (firstRequest && !isLoading && !focusedInputDialog) {
          void sendNotification(
            {
              message: `${firstRequest.workerName} needs network access to ${firstRequest.host}`,
              notificationType: 'worker_permission_prompt',
            },
            terminal,
          )
        }
      }
    }

    // 处理 sandbox 权限响应（worker 侧），调用已注册 callback
    if (sandboxPermissionResponses.length > 0 && isTeammate()) {
      logForDebugging(
        `[InboxPoller] Found ${sandboxPermissionResponses.length} sandbox permission response(s)`,
      )

      for (const m of sandboxPermissionResponses) {
        const parsed = isSandboxPermissionResponse(m.text)
        if (!parsed) {
          continue
        }

        // Check if we have a registered callback for this request
        if (hasSandboxPermissionCallback(parsed.requestId)) {
          logForDebugging(
            `[InboxPoller] Processing sandbox permission response for ${parsed.requestId}: allow=${parsed.allow}`,
          )

          // Process the response using the exported function
          processSandboxPermissionResponse({
            requestId: parsed.requestId,
            host: parsed.host,
            allow: parsed.allow,
          })

          // Clear the pending sandbox request indicator
          setAppState((prev) => ({
            ...prev,
            pendingSandboxRequest: null,
          }))
        }
      }
    }

    // 处理 team 权限更新（teammate 侧），将权限应用到 context
    if (teamPermissionUpdates.length > 0 && isTeammate()) {
      logForDebugging(
        `[InboxPoller] Found ${teamPermissionUpdates.length} team permission update(s)`,
      )

      for (const m of teamPermissionUpdates) {
        const parsed = isTeamPermissionUpdate(m.text)
        if (!parsed) {
          logForDebugging(
            `[InboxPoller] Failed to parse team permission update: ${m.text.substring(0, 100)}`,
          )
          continue
        }

        // 校验必需的嵌套字段，避免畸形消息导致崩溃
        if (!parsed.permissionUpdate?.rules || !parsed.permissionUpdate?.behavior) {
          logForDebugging(
            `[InboxPoller] Invalid team permission update: missing permissionUpdate.rules or permissionUpdate.behavior`,
          )
          continue
        }

        // Apply the permission update to the teammate's context
        logForDebugging(
          `[InboxPoller] Applying team permission update: ${parsed.toolName} allowed in ${parsed.directoryPath}`,
        )
        logForDebugging(
          `[InboxPoller] Permission update rules: ${jsonStringify(parsed.permissionUpdate.rules)}`,
        )

        setAppState((prev) => {
          const updated = applyPermissionUpdate(prev.toolPermissionContext, {
            type: 'addRules',
            rules: parsed.permissionUpdate.rules,
            behavior: parsed.permissionUpdate.behavior,
            destination: 'session',
          })
          logForDebugging(
            `[InboxPoller] Updated session allow rules: ${jsonStringify(updated.alwaysAllowRules.session)}`,
          )
          return {
            ...prev,
            toolPermissionContext: updated,
          }
        })
      }
    }

    // 处理模式设置请求（teammate 侧），即 team lead 修改 teammate 模式
    if (modeSetRequests.length > 0 && isTeammate()) {
      logForDebugging(`[InboxPoller] Found ${modeSetRequests.length} mode set request(s)`)

      for (const m of modeSetRequests) {
        // 只接受来自 team lead 的模式变化
        if (m.from !== 'team-lead') {
          logForDebugging(`[InboxPoller] Ignoring mode set request from non-team-lead: ${m.from}`)
          continue
        }

        const parsed = isModeSetRequest(m.text)
        if (!parsed) {
          logForDebugging(
            `[InboxPoller] Failed to parse mode set request: ${m.text.substring(0, 100)}`,
          )
          continue
        }

        const targetMode = permissionModeFromString(parsed.mode)
        logForDebugging(`[InboxPoller] Applying mode change from team-lead: ${targetMode}`)

        // 更新本地权限 context
        setAppState((prev) => ({
          ...prev,
          toolPermissionContext: applyPermissionUpdate(prev.toolPermissionContext, {
            type: 'setMode',
            mode: toExternalPermissionMode(targetMode),
            destination: 'session',
          }),
        }))

        // 更新 config.json，使 team lead 能看到新模式
        const teamName = currentAppState.teamContext?.teamName
        const agentName = getAgentName()
        if (teamName && agentName) {
          setMemberMode(teamName, agentName, targetMode)
        }
      }
    }

    // 处理 plan approval 请求（leader 侧），自动批准并将响应写入 teammate inbox
    if (planApprovalRequests.length > 0 && isTeamLead(currentAppState.teamContext)) {
      logForDebugging(
        `[InboxPoller] Found ${planApprovalRequests.length} plan approval request(s), auto-approving`,
      )

      const teamName = currentAppState.teamContext?.teamName
      const leaderExternalMode = toExternalPermissionMode(
        currentAppState.toolPermissionContext.mode,
      )
      const modeToInherit = leaderExternalMode === 'plan' ? 'default' : leaderExternalMode

      for (const m of planApprovalRequests) {
        const parsed = isPlanApprovalRequest(m.text)
        if (!parsed) {
          continue
        }

        // 将 approval 响应写入 teammate inbox
        const approvalResponse = {
          type: 'plan_approval_response',
          requestId: parsed.requestId,
          approved: true,
          timestamp: new Date().toISOString(),
          permissionMode: modeToInherit,
        }

        void writeToMailbox(
          m.from,
          {
            from: TEAM_LEAD_NAME,
            text: jsonStringify(approvalResponse),
            timestamp: new Date().toISOString(),
          },
          teamName,
        )

        // 适用时更新进程内 teammate 的任务状态
        const taskId = findInProcessTeammateTaskId(m.from, currentAppState)
        if (taskId) {
          handlePlanApprovalResponse(
            taskId,
            {
              type: 'plan_approval_response',
              requestId: parsed.requestId,
              approved: true,
              timestamp: new Date().toISOString(),
              permissionMode: modeToInherit,
            },
            setAppState,
          )
        }

        logForDebugging(
          `[InboxPoller] Auto-approved plan from ${m.from} (request ${parsed.requestId})`,
        )

        // Still pass through as a regular message so the model has context
        // about what the teammate is doing, but the approval is already sent
        regularMessages.push(m)
      }
    }

    // 处理 shutdown 请求（teammate 侧），保留 JSON 供 UI 渲染
    if (shutdownRequests.length > 0 && isTeammate()) {
      logForDebugging(`[InboxPoller] Found ${shutdownRequests.length} shutdown request(s)`)

      // 透传 shutdown 请求，由 UI 组件友好渲染，模型则通过 tool prompt 文档接收指令
      for (const m of shutdownRequests) {
        regularMessages.push(m)
      }
    }

    // 处理 shutdown approval（leader 侧），终止 teammate pane
    if (shutdownApprovals.length > 0 && isTeamLead(currentAppState.teamContext)) {
      logForDebugging(`[InboxPoller] Found ${shutdownApprovals.length} shutdown approval(s)`)

      for (const m of shutdownApprovals) {
        const parsed = isShutdownApproved(m.text)
        if (!parsed) {
          continue
        }

        // 若有相关信息，则终止 pane（基于 pane 的 teammate）
        if (parsed.paneId && parsed.backendType) {
          void (async () => {
            try {
              // 确保 backend class 已导入（不探测 subprocess）
              await ensureBackendsRegistered()
              const insideTmux = await isInsideTmux()
              const backend = getBackendByType(parsed.backendType as PaneBackendType)
              const success = await backend?.killPane(parsed.paneId!, !insideTmux)
              logForDebugging(
                `[InboxPoller] Killed pane ${parsed.paneId} for ${parsed.from}: ${success}`,
              )
            } catch (error) {
              logForDebugging(`[InboxPoller] Failed to kill pane for ${parsed.from}: ${error}`)
            }
          })()
        }

        // 从 teamContext.teammates 移除 teammate，确保计数准确
        const teammateToRemove = parsed.from
        if (teammateToRemove && currentAppState.teamContext?.teammates) {
          // 按名称查找 teammate ID
          const teammateId = Object.entries(currentAppState.teamContext.teammates).find(
            ([, t]) => t.name === teammateToRemove,
          )?.[0]

          if (teammateId) {
            // 从 team 文件移除（team 文件仅由 leader 修改）
            const teamName = currentAppState.teamContext?.teamName
            if (teamName) {
              removeTeammateFromTeamFile(teamName, {
                agentId: teammateId,
                name: teammateToRemove,
              })
            }

            // 取消任务分配并构造通知消息
            const { notificationMessage } = teamName
              ? await unassignTeammateTasks(teamName, teammateId, teammateToRemove, 'shutdown')
              : { notificationMessage: `${teammateToRemove} has shut down.` }

            setAppState((prev) => {
              if (!prev.teamContext?.teammates) {
                return prev
              }
              if (!(teammateId in prev.teamContext.teammates)) {
                return prev
              }
              const { [teammateId]: _, ...remainingTeammates } = prev.teamContext.teammates

              // Mark the teammate's task as completed so hasRunningTeammates
              // becomes false and the spinner stops. Without this, out-of-process
              // (tmux) teammate tasks stay status:'running' forever because
              // only in-process teammates have a runner that sets 'completed'.
              const updatedTasks = { ...prev.tasks }
              for (const [tid, task] of Object.entries(updatedTasks)) {
                if (isInProcessTeammateTask(task) && task.identity.agentId === teammateId) {
                  updatedTasks[tid] = {
                    ...task,
                    status: 'completed' as const,
                    endTime: Date.now(),
                  }
                }
              }

              return {
                ...prev,
                tasks: updatedTasks,
                teamContext: {
                  ...prev.teamContext,
                  teammates: remainingTeammates,
                },
                inbox: {
                  messages: [
                    ...prev.inbox.messages,
                    {
                      id: randomUUID(),
                      from: 'system',
                      text: jsonStringify({
                        type: 'teammate_terminated',
                        message: notificationMessage,
                      }),
                      timestamp: new Date().toISOString(),
                      status: 'pending' as const,
                    },
                  ],
                },
              }
            })
            logForDebugging(
              `[InboxPoller] Removed ${teammateToRemove} (${teammateId}) from teamContext`,
            )
          }
        }

        // 透传给 UI 渲染，由组件友好展示
        regularMessages.push(m)
      }
    }

    // 处理普通 teammate 消息（现有逻辑）
    if (regularMessages.length === 0) {
      // 没有普通消息，但上方可能已处理权限、shutdown 请求等特殊消息；将其标记为已读。
      markRead()
      return
    }

    // 用 XML wrapper 格式化发给 ZY 的消息，并在可用时包含颜色
    // 转换 plan approval 请求，使其包含给 ZY 的指令
    const formatted = regularMessages
      .map((m) => {
        const colorAttr = m.color ? ` color="${m.color}"` : ''
        const summaryAttr = m.summary ? ` summary="${m.summary}"` : ''
        const messageContent = m.text

        return `<${TEAMMATE_MESSAGE_TAG} teammate_id="${m.from}"${colorAttr}${summaryAttr}>\n${messageContent}\n</${TEAMMATE_MESSAGE_TAG}>`
      })
      .join('\n\n')

    // 将消息放入 AppState 队列、供稍后投递的辅助函数
    const queueMessages = () => {
      setAppState((prev) => ({
        ...prev,
        inbox: {
          messages: [
            ...prev.inbox.messages,
            ...regularMessages.map((m) => ({
              id: randomUUID(),
              from: m.from,
              text: m.text,
              timestamp: m.timestamp,
              status: 'pending' as const,
              color: m.color,
              summary: m.summary,
            })),
          ],
        },
      }))
    }

    if (!isLoading && !focusedInputDialog) {
      // 空闲：立即作为新轮次提交
      logForDebugging(`[InboxPoller] Session idle, submitting immediately`)
      const submitted = onSubmitTeammateMessage(formatted)
      if (!submitted) {
        // 提交被拒（query 已在运行），放入队列稍后处理
        logForDebugging(`[InboxPoller] Submission rejected, queuing for later delivery`)
        queueMessages()
      }
    } else {
      // 忙碌：加入 inbox 队列，供 UI 显示和稍后投递
      logForDebugging(`[InboxPoller] Session busy, queuing for later delivery`)
      queueMessages()
    }

    // Mark messages as read only after they have been successfully delivered
    // or reliably queued in AppState. This prevents permanent message loss
    // when the session is busy — if we crash before this point, the messages
    // will be re-read on the next poll cycle instead of being silently dropped.
    markRead()
  }, [
    enabled,
    isLoading,
    focusedInputDialog,
    onSubmitTeammateMessage,
    setAppState,
    terminal,
    store,
  ])

  // 会话变为空闲时，投递待处理消息并清理已处理消息
  useEffect(() => {
    if (!enabled) {
      return
    }

    // 忙碌或处于 dialog 中时跳过
    if (isLoading || focusedInputDialog) {
      return
    }

    // 使用 ref 避免依赖 appState 对象，防止无限循环
    const currentAppState = store.getState()
    const agentName = getAgentNameToPoll(currentAppState)
    if (!agentName) {
      return
    }

    const pendingMessages = currentAppState.inbox.messages.filter((m) => m.status === 'pending')
    const processedMessages = currentAppState.inbox.messages.filter((m) => m.status === 'processed')

    // 清理已处理消息（已在轮次中途作为 attachment 投递）
    if (processedMessages.length > 0) {
      logForDebugging(
        `[InboxPoller] Cleaning up ${processedMessages.length} processed message(s) that were delivered mid-turn`,
      )
      const processedIds = new Set(processedMessages.map((m) => m.id))
      setAppState((prev) => ({
        ...prev,
        inbox: {
          messages: prev.inbox.messages.filter((m) => !processedIds.has(m.id)),
        },
      }))
    }

    // 没有待投递消息
    if (pendingMessages.length === 0) {
      return
    }

    logForDebugging(
      `[InboxPoller] Session idle, delivering ${pendingMessages.length} pending message(s)`,
    )

    // 用 XML wrapper 格式化发给 Zy 的消息，并在可用时包含颜色
    const formatted = pendingMessages
      .map((m) => {
        const colorAttr = m.color ? ` color="${m.color}"` : ''
        const summaryAttr = m.summary ? ` summary="${m.summary}"` : ''
        return `<${TEAMMATE_MESSAGE_TAG} teammate_id="${m.from}"${colorAttr}${summaryAttr}>\n${m.text}\n</${TEAMMATE_MESSAGE_TAG}>`
      })
      .join('\n\n')

    // 尝试提交，仅在成功后清除消息
    const submitted = onSubmitTeammateMessage(formatted)
    if (submitted) {
      // 按 ID 清除刚提交的特定消息
      const submittedIds = new Set(pendingMessages.map((m) => m.id))
      setAppState((prev) => ({
        ...prev,
        inbox: {
          messages: prev.inbox.messages.filter((m) => !submittedIds.has(m.id)),
        },
      }))
    } else {
      logForDebugging(`[InboxPoller] Submission rejected, keeping messages queued`)
    }
  }, [enabled, isLoading, focusedInputDialog, onSubmitTeammateMessage, setAppState, store])

  // 作为 teammate 或 team lead 运行时轮询
  const shouldPoll = enabled && !!getAgentNameToPoll(store.getState())
  useInterval(() => void poll(), shouldPoll ? INBOX_POLL_INTERVAL_MS : null)

  // 挂载时进行一次初始轮询
  const hasDoneInitialPollRef = useRef(false)
  useEffect(() => {
    if (!enabled) {
      return
    }
    if (hasDoneInitialPollRef.current) {
      return
    }
    // 使用 store.getState() 避免依赖 appState 对象
    if (getAgentNameToPoll(store.getState())) {
      hasDoneInitialPollRef.current = true
      void poll()
    }
    // Note: poll uses store.getState() (not appState) so it won't re-run on appState changes
    // The ref guard is a safety measure to ensure initial poll only happens once
  }, [enabled, poll, store])
}
