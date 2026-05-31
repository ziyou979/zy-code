import figures from 'figures'
import React, { useMemo, useState } from 'react'
import type { ToolUseContext } from 'src/Tool.js'
import type { WireMessage } from 'src/types/index.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  SystemMessage,
  UserMessage,
} from 'src/types/message.js'
import type { DeepImmutable } from 'src/types/utils.js'
import type { CommandResultDisplay } from '../../commands.js'
import { DIAMOND_FILLED, DIAMOND_OPEN } from '../../constants/figures.js'
import { useElapsedTime } from '../../hooks/useElapsedTime.js'
import { tSync } from '../../i18n/index.js'
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js'
import { Box, Link, Text } from '../../ink.js'
import type { RemoteAgentTaskState } from '../../tasks/RemoteAgentTask/RemoteAgentTask.js'
import { getRemoteTaskSessionUrl } from '../../tasks/RemoteAgentTask/RemoteAgentTask.js'
import { AGENT_TOOL_NAME, LEGACY_AGENT_TOOL_NAME } from '../../tools/AgentTool/constants.js'
import { ASK_USER_QUESTION_TOOL_NAME } from '../../tools/AskUserQuestionTool/prompt.js'
import { EXIT_PLAN_MODE_V2_TOOL_NAME } from '../../tools/ExitPlanModeTool/constants.js'
import { openBrowser } from '../../utils/browser.js'
import { errorMessage } from '../../utils/errors.js'
import { formatDuration, truncateToWidth } from '../../utils/format.js'
import { toInternalMessages } from '../../utils/messages/mappers.js'
import { EMPTY_LOOKUPS, normalizeMessages } from '../../utils/messages.js'
import { plural } from '../../utils/stringUtils.js'
import { teleportResumeCodeSession } from '../../utils/teleport.js'
import { Select } from '../CustomSelect/select.js'
import { Byline } from '../design-system/Byline.js'
import { Dialog } from '../design-system/Dialog.js'
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js'
import { Message } from '../Message.js'
import { formatReviewStageCounts, RemoteSessionProgress } from './RemoteSessionProgress.js'

type Props = {
  session: DeepImmutable<RemoteAgentTaskState>
  toolUseContext: ToolUseContext
  onDone: (
    result?: string,
    options?: {
      display?: CommandResultDisplay
    },
  ) => void
  onBack?: () => void
  onKill?: () => void
}

// 单行摘要：工具名 + 第一个有意义的字符串参数。
// 比 tool.renderToolUseMessage 更轻量（无需注册表查找 / 模式解析）。
// 折叠空白字符，使多行输入（如 Bash 命令文本）
// 渲染为单行。
export function formatToolUseSummary(name: string, input: unknown): string {
  // plan_ready 阶段仅通过 ExitPlanMode 工具到达
  if (name === EXIT_PLAN_MODE_V2_TOOL_NAME) {
    return tSync('backgroundTasks.reviewPlanOnWeb')
  }
  if (!input || typeof input !== 'object') {
    return name
  }
  // AskUserQuestion：将问题文本显示为 CTA，而非工具名。
  // 输入格式为 {questions: [{question, header, options}]}。
  if (name === ASK_USER_QUESTION_TOOL_NAME && 'questions' in input) {
    const qs = input.questions
    if (Array.isArray(qs) && qs[0] && typeof qs[0] === 'object') {
      // 优先使用 question（完整文本）而非 header（最多 12 字符标签）。header
      // 是必填的模式字段，因此先检查它会使 question 的 fallback 成为死代码。
      const q =
        'question' in qs[0] && typeof qs[0].question === 'string' && qs[0].question
          ? qs[0].question
          : 'header' in qs[0] && typeof qs[0].header === 'string'
            ? qs[0].header
            : null
      if (q) {
        const oneLine = q.replace(/\s+/g, ' ').trim()
        return `${tSync('backgroundTasks.answerInBrowser')}: ${truncateToWidth(oneLine, 50)}`
      }
    }
  }
  for (const v of Object.values(input)) {
    if (typeof v === 'string' && v.trim()) {
      const oneLine = v.replace(/\s+/g, ' ').trim()
      return `${name} ${truncateToWidth(oneLine, 60)}`
    }
  }
  return name
}
// getter：惰性求值，避免模块顶层冻结翻译；语言切换后即时反应。
const getPhaseLabel = () =>
  ({
    needs_input: tSync('backgroundTasks.inputRequired'),
    plan_ready: tSync('backgroundTasks.ready'),
  }) as const
const getAgentVerb = () =>
  ({
    needs_input: tSync('backgroundTasks.waiting'),
    plan_ready: tSync('backgroundTasks.done'),
  }) as const
function UltraplanSessionDetail({ session, toolUseContext, onDone, onBack, onKill }) {
  const running = session.status === 'running' || session.status === 'pending'
  const phase = session.ultraplanPhase
  const statusText = running ? (phase ? getPhaseLabel()[phase] : 'running') : session.status
  const elapsedTime = useElapsedTime(session.startTime, running, 1000, 0, session.endTime)
  let spawns = 0
  let calls = 0
  let lastBlock = null
  for (const msg of session.log) {
    if (msg.type !== 'assistant') {
      continue
    }
    for (const block of msg.message.content) {
      if (block.type !== 'tool_use') {
        continue
      }
      calls++
      lastBlock = block
      if (block.name === AGENT_TOOL_NAME || block.name === LEGACY_AGENT_TOOL_NAME) {
        spawns++
      }
    }
  }
  const lastToolSummary = lastBlock ? formatToolUseSummary(lastBlock.name, lastBlock.input) : null
  const { agentsWorking, toolCalls, lastToolCall } = {
    agentsWorking: 1 + spawns,
    toolCalls: calls,
    lastToolCall: lastToolSummary,
  }
  const sessionUrl = getRemoteTaskSessionUrl(session.sessionId)
  const goBackOrClose =
    onBack ??
    (() =>
      onDone('Remote session details dismissed', {
        display: 'system',
      }))
  const [confirmingStop, setConfirmingStop] = useState(false)
  if (confirmingStop) {
    return (
      <Dialog
        title={tSync('backgroundTasks.stopUltraplan')}
        onCancel={() => setConfirmingStop(false)}
        color="background"
      >
        <Box flexDirection="column" gap={1}>
          {<Text dimColor={true}>{tSync('backgroundTasks.stopUltraplanConfirm')}</Text>}
          <Select
            options={[
              {
                label: tSync('backgroundTasks.terminateSession'),
                value: 'stop' as const,
              },
              {
                label: tSync('backgroundTasks.back'),
                value: 'back' as const,
              },
            ]}
            onChange={(v) => {
              if (v === 'stop') {
                onKill?.()
                goBackOrClose()
              } else {
                setConfirmingStop(false)
              }
            }}
          />
        </Box>
      </Dialog>
    )
  }
  const agentLabel = plural(agentsWorking, 'agent')
  const toolCallLabel = plural(toolCalls, 'call')
  return (
    <Dialog
      title={
        <Text>
          {
            <Text color="background">
              {phase === 'plan_ready' ? DIAMOND_FILLED : DIAMOND_OPEN}{' '}
            </Text>
          }
          {<Text bold={true}>ultraplan</Text>}
          {
            <Text dimColor={true}>
              {' \xB7 '}
              {elapsedTime}
              {' \xB7 '}
              {statusText}
            </Text>
          }
        </Text>
      }
      onCancel={goBackOrClose}
      color="background"
    >
      {
        <Box flexDirection="column" gap={1}>
          {
            <Text>
              {phase === 'plan_ready' && <Text color="success">{figures.tick} </Text>}
              {agentsWorking} {agentLabel}{' '}
              {phase ? getAgentVerb()[phase] : tSync('backgroundTasks.working')} · {toolCalls} tool{' '}
              {toolCallLabel}
            </Text>
          }
          {lastToolCall && <Text dimColor={true}>{lastToolCall}</Text>}
          {<Link url={sessionUrl}>{<Text dimColor={true}>{sessionUrl}</Text>}</Link>}
          {
            <Select
              options={[
                {
                  label: tSync('backgroundTasks.reviewOnWeb'),
                  value: 'open' as const,
                },
                ...(onKill && running
                  ? [
                      {
                        label: tSync('backgroundTasks.stopUltraplanLabel'),
                        value: 'stop' as const,
                      },
                    ]
                  : []),
                {
                  label: tSync('backgroundTasks.back'),
                  value: 'back' as const,
                },
              ]}
              onChange={(selectedAction: any) => {
                switch (selectedAction) {
                  case 'open': {
                    openBrowser(sessionUrl)
                    onDone()
                    return
                  }
                  case 'stop': {
                    setConfirmingStop(true)
                    return
                  }
                  case 'back': {
                    goBackOrClose()
                    return
                  }
                }
              }}
            />
          }
        </Box>
      }
    </Dialog>
  )
}
const STAGES = ['finding', 'verifying', 'synthesizing'] as const
// getter：惰性求值，避免模块顶层冻结翻译；语言切换后即时反应。
const getStageLabels = (): Record<(typeof STAGES)[number], string> => ({
  finding: tSync('backgroundTasks.stageFind'),
  verifying: tSync('backgroundTasks.stageVerify'),
  synthesizing: tSync('backgroundTasks.stageDedupe'),
})

// Setup → Find → Verify → Dedupe 流水线。当前阶段显示为云青色，
// 其余阶段变暗。完成后，所有阶段变暗并附加绿色 ✓。
// "Setup" 标签在编排器写入第一个进度快照前显示
//（容器启动 + 仓库克隆），这样 0 发现的显示不会
// 看起来像卡住的查找器。
function StagePipeline({ stage, completed, hasProgress }) {
  const currentIdx = stage ? STAGES.indexOf(stage) : -1
  const inSetup = !completed && !hasProgress
  const stageElements = STAGES.map((stage, index) => {
    const isCurrent = !completed && !inSetup && index === currentIdx
    return (
      <React.Fragment key={stage}>
        {index > 0 && <Text dimColor={true}> → </Text>}
        {isCurrent ? (
          <Text color="background">{getStageLabels()[stage]}</Text>
        ) : (
          <Text dimColor={true}>{getStageLabels()[stage]}</Text>
        )}
      </React.Fragment>
    )
  })
  return (
    <Text>
      {inSetup ? (
        <Text color="background">{tSync('backgroundTasks.stageSetup')}</Text>
      ) : (
        <Text dimColor={true}>{tSync('backgroundTasks.stageSetup')}</Text>
      )}
      {<Text dimColor={true}> → </Text>}
      {stageElements}
      {completed && <Text color="success"> ✓</Text>}
    </Text>
  )
}

// 阶段相关的计数行。运行状态的格式化委托给
// formatReviewStageCounts（与 pill 共享），这样两个视图不会
// 漂移；完成状态是对话框特定的（发现摘要）。
function reviewCountsLine(session: DeepImmutable<RemoteAgentTaskState>): string {
  const p = session.reviewProgress
  // 没有进度数据 —— 编排器从未写入快照。完成时
  // 不要声称"0 发现"；我们只是不知道。
  if (!p) {
    return session.status === 'completed'
      ? tSync('backgroundTasks.done')
      : tSync('backgroundTasks.settingUp')
  }
  const verified = p.bugsVerified
  const refuted = p.bugsRefuted ?? 0
  if (session.status === 'completed') {
    const parts = [`${verified} ${plural(verified, 'finding')}`]
    if (refuted > 0) {
      parts.push(`${refuted} refuted`)
    }
    return parts.join(' · ')
  }
  return formatReviewStageCounts(p.stage, p.bugsFound, verified, refuted)
}
type MenuAction = 'open' | 'stop' | 'back' | 'dismiss'
function ReviewSessionDetail({ session, onDone, onBack, onKill }) {
  const completed = session.status === 'completed'
  const running = session.status === 'running' || session.status === 'pending'
  const [confirmingStop, setConfirmingStop] = useState(false)
  const elapsedTime = useElapsedTime(session.startTime, running, 1000, 0, session.endTime)
  const handleClose = () =>
    onDone('Remote session details dismissed', {
      display: 'system',
    })
  const goBackOrClose = onBack ?? handleClose
  const sessionUrl = getRemoteTaskSessionUrl(session.sessionId)
  const statusLabel = completed
    ? tSync('backgroundTasks.ready')
    : running
      ? tSync('backgroundTasks.running')
      : session.status
  if (confirmingStop) {
    return (
      <Dialog
        title={tSync('backgroundTasks.stopUltrareview')}
        onCancel={() => setConfirmingStop(false)}
        color="background"
      >
        <Box flexDirection="column" gap={1}>
          {<Text dimColor={true}>{tSync('backgroundTasks.stopUltrareviewConfirm')}</Text>}
          <Select
            options={[
              {
                label: tSync('backgroundTasks.stopUltrareviewLabel'),
                value: 'stop' as const,
              },
              {
                label: tSync('backgroundTasks.back'),
                value: 'back' as const,
              },
            ]}
            onChange={(v: string) => {
              if (v === 'stop') {
                onKill?.()
                goBackOrClose()
              } else {
                setConfirmingStop(false)
              }
            }}
          />
        </Box>
      </Dialog>
    )
  }
  const options = completed
    ? [
        {
          label: tSync('backgroundTasks.openOnWeb'),
          value: 'open',
        },
        {
          label: tSync('backgroundTasks.dismiss'),
          value: 'dismiss',
        },
      ]
    : [
        {
          label: tSync('backgroundTasks.openOnWeb'),
          value: 'open',
        },
        ...(onKill && running
          ? [
              {
                label: tSync('backgroundTasks.stopUltrareviewLabel'),
                value: 'stop' as const,
              },
            ]
          : []),
        {
          label: tSync('backgroundTasks.back'),
          value: 'back',
        },
      ]
  const handleSelect = (action: MenuAction) => {
    switch (action) {
      case 'open': {
        openBrowser(sessionUrl)
        onDone()
        break
      }
      case 'stop': {
        setConfirmingStop(true)
        break
      }
      case 'back': {
        goBackOrClose()
        break
      }
      case 'dismiss': {
        handleClose()
      }
    }
  }
  const reviewStage = session.reviewProgress?.stage
  const reviewCounts = reviewCountsLine(session)
  return (
    <Dialog
      title={
        <Text>
          {<Text color="background">{completed ? DIAMOND_FILLED : DIAMOND_OPEN} </Text>}
          {<Text bold={true}>ultrareview</Text>}
          {
            <Text dimColor={true}>
              {' \xB7 '}
              {elapsedTime}
              {' \xB7 '}
              {statusLabel}
            </Text>
          }
        </Text>
      }
      onCancel={goBackOrClose}
      color="background"
      inputGuide={(exitState) =>
        exitState.pending ? (
          <Text>Press {exitState.keyName} again to exit</Text>
        ) : (
          <Byline>
            <KeyboardShortcutHint shortcut="Enter" action="select" />
            <KeyboardShortcutHint shortcut="Esc" action="go back" />
          </Byline>
        )
      }
    >
      {
        <Box flexDirection="column" gap={1}>
          {
            <StagePipeline
              stage={reviewStage}
              completed={completed}
              hasProgress={!!session.reviewProgress}
            />
          }
          {
            <Box flexDirection="column">
              {<Text>{reviewCounts}</Text>}
              {<Link url={sessionUrl}>{<Text dimColor={true}>{sessionUrl}</Text>}</Link>}
            </Box>
          }
          {<Select options={options} onChange={handleSelect} />}
        </Box>
      }
    </Dialog>
  )
}
export function RemoteSessionDetailDialog({
  session,
  toolUseContext,
  onDone,
  onBack,
  onKill,
}: Props): React.ReactNode {
  const [isTeleporting, setIsTeleporting] = useState(false)
  const [teleportError, setTeleportError] = useState<string | null>(null)

  // 获取远程会话的最后几条消息用于显示。
  // 扫描所有消息（不仅是最后 3 条原始条目），因为日志尾部
  // 通常只有思考块，会被归一化为 'progress' 类型。
  // 放在提前返回之前，以确保 hook 调用顺序稳定（Hooks 规则）。
  // Ultraplan/review 会话从不读取此数据 —— 跳过它们的归一化工作。
  const lastMessages = useMemo(() => {
    if (session.isUltraplan || session.isRemoteReview) {
      return []
    }
    return normalizeMessages(toInternalMessages(session.log as WireMessage[]))
      .filter(
        (_): _ is UserMessage | AssistantMessage | AttachmentMessage | SystemMessage =>
          _.type !== 'progress',
      )
      .slice(-3)
  }, [session])
  if (session.isUltraplan) {
    return (
      <UltraplanSessionDetail
        session={session}
        toolUseContext={toolUseContext}
        onDone={onDone}
        onBack={onBack}
        onKill={onKill}
      />
    )
  }

  // Review 会话获得阶段流水线视图；其他所有内容保留
  // 通用标签/值 + 下方最近消息对话框。
  if (session.isRemoteReview) {
    return <ReviewSessionDetail session={session} onDone={onDone} onBack={onBack} onKill={onKill} />
  }
  const handleClose = () =>
    onDone('Remote session details dismissed', {
      display: 'system',
    })

  // 在 UI 提示中显示的组件特定快捷键（t=传送，空格=关闭，
  // 左箭头=返回）。这些是状态相关的操作，不是标准对话框快捷键。
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === ' ') {
      e.preventDefault()
      onDone('Remote session details dismissed', {
        display: 'system',
      })
    } else if (e.key === 'left' && onBack) {
      e.preventDefault()
      onBack()
    } else if (e.key === 't' && !isTeleporting) {
      e.preventDefault()
      void handleTeleport()
    } else if (e.key === 'return') {
      e.preventDefault()
      handleClose()
    }
  }

  // 处理传送到远程会话
  async function handleTeleport(): Promise<void> {
    setIsTeleporting(true)
    setTeleportError(null)
    try {
      await teleportResumeCodeSession(session.sessionId)
    } catch (err) {
      setTeleportError(errorMessage(err))
    } finally {
      setIsTeleporting(false)
    }
  }

  // 如果标题太长则截断（用于显示）
  const displayTitle = truncateToWidth(session.title, 50)

  // 将 TaskStatus 映射到显示状态（处理 'pending'）
  const displayStatus =
    session.status === 'pending' ? tSync('backgroundTasks.starting') : session.status
  return (
    <Box flexDirection="column" tabIndex={0} autoFocus onKeyDown={handleKeyDown}>
      <Dialog
        title={tSync('backgroundTasks.remoteSessionDetails')}
        onCancel={handleClose}
        color="background"
        inputGuide={(exitState) =>
          exitState.pending ? (
            <Text>Press {exitState.keyName} again to exit</Text>
          ) : (
            <Byline>
              {onBack && <KeyboardShortcutHint shortcut="←" action="go back" />}
              <KeyboardShortcutHint shortcut="Esc/Enter/Space" action="close" />
              {!isTeleporting && <KeyboardShortcutHint shortcut="t" action="teleport" />}
            </Byline>
          )
        }
      >
        <Box flexDirection="column">
          <Text>
            <Text bold>{tSync('backgroundTasks.status')}</Text>:{' '}
            {displayStatus === 'running' || displayStatus === 'starting' ? (
              <Text color="background">{displayStatus}</Text>
            ) : displayStatus === 'completed' ? (
              <Text color="success">{displayStatus}</Text>
            ) : (
              <Text color="error">{displayStatus}</Text>
            )}
          </Text>
          <Text>
            <Text bold>{tSync('backgroundTasks.runtime')}</Text>:{' '}
            {formatDuration((session.endTime ?? Date.now()) - session.startTime)}
          </Text>
          <Text wrap="truncate-end">
            <Text bold>{tSync('backgroundTasks.titleLabel')}</Text>: {displayTitle}
          </Text>
          <Text>
            <Text bold>{tSync('backgroundTasks.progress')}</Text>:{' '}
            <RemoteSessionProgress session={session} />
          </Text>
          <Text>
            <Text bold>{tSync('backgroundTasks.sessionUrl')}</Text>:{' '}
            <Link url={getRemoteTaskSessionUrl(session.sessionId)}>
              <Text dimColor>{getRemoteTaskSessionUrl(session.sessionId)}</Text>
            </Link>
          </Text>
        </Box>

        {/* Remote session messages section */}
        {session.log.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text>
              <Text bold>{tSync('backgroundTasks.recentMessages')}</Text>:
            </Text>
            <Box flexDirection="column" height={10} overflowY="hidden">
              {lastMessages.map((msg, i) => (
                <Message
                  key={i}
                  message={msg}
                  lookups={EMPTY_LOOKUPS}
                  addMargin={i > 0}
                  tools={toolUseContext.options.tools}
                  commands={toolUseContext.options.commands}
                  verbose={toolUseContext.options.verbose}
                  inProgressToolUseIDs={new Set()}
                  progressMessagesForMessage={[]}
                  shouldAnimate={false}
                  shouldShowDot={false}
                  style="condensed"
                  isTranscriptMode={false}
                  isStatic={true}
                />
              ))}
            </Box>
            <Box marginTop={1}>
              <Text dimColor italic>
                {tSync('backgroundTasks.showingLastMessages', {
                  shown: lastMessages.length,
                  total: session.log.length,
                })}
              </Text>
            </Box>
          </Box>
        )}

        {/* Teleport error message */}
        {teleportError && (
          <Box marginTop={1}>
            <Text color="error">
              {tSync('backgroundTasks.teleportFailed', { error: teleportError })}
            </Text>
          </Box>
        )}

        {/* Teleporting status */}
        {isTeleporting && <Text color="background">{tSync('backgroundTasks.teleporting')}</Text>}
      </Dialog>
    </Box>
  )
}
