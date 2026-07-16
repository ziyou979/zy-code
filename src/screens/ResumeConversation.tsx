import { feature } from 'bun:bundle'
import { dirname } from 'node:path'
import React from 'react'
import { useTerminalSize } from 'src/hooks/useTerminalSize.js'
import { getOriginalCwd, switchSession } from 'src/bootstrap/runtime/runtimeContext.js'
import type { Command } from '../commands/index.js'
import { LogSelector } from '../components/LogSelector.js'
import { Spinner } from '../components/Spinner.js'
import { restoreCostStateForSession } from '../services/cost/cost-tracker.js'
import { tSync } from '../i18n/index.js'
import { setClipboard } from '../ink/termio/osc.js'
import { Box, Text } from '../ink/index.js'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../services/analytics/index.js'
import type { MCPServerConnection, ScopedMcpServerConfig } from '../services/mcp/types.js'
import { useAppState, useSetAppState } from '../state/AppState.js'
import type { Tool } from '../tools/Tool.js'
import type { AgentColorName } from '../tools/AgentTool/agentColorManager.js'
import type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'
import { asSessionId } from '../types/ids.js'
import type { LogOption } from '../types/logs.js'
import type { Message } from '../types/message.js'
import { agenticSessionSearch } from '../utils/agenticSessionSearch.js'
import { renameRecordingForSession } from '../services/shell/asciicast.js'
import { updateSessionName } from '../utils/concurrentSessions.js'
import { loadConversationForResume } from '../utils/conversationRecovery.js'
import { checkCrossProjectResume } from '../utils/crossProjectResume.js'
import type { FileHistorySnapshot } from '../utils/fileHistory.js'
import { logError } from '../utils/log.js'
import { createSystemMessage } from '../services/messages/./constructors.js'
import {
  computeStandaloneAgentContext,
  restoreAgentFromSession,
  restoreWorktreeForResume,
} from '../utils/sessionRestore.js'
import {
  adoptResumedSessionFile,
  enrichLogs,
  isCustomTitleEnabled,
  loadAllProjectsMessageLogsProgressive,
  loadSameRepoMessageLogsProgressive,
  recordContentReplacement,
  resetSessionFilePointer,
  restoreSessionMetadata,
  type SessionLogResult,
} from '../services/sessionStorage.js'
import type { ThinkingConfig } from '../utils/thinking.js'
import type { ContentReplacementRecord } from '../utils/toolResultStorage.js'
import { REPL } from './REPL.js'

function parsePrIdentifier(value: string): number | null {
  const directNumber = parseInt(value, 10)
  if (!Number.isNaN(directNumber) && directNumber > 0) {
    return directNumber
  }
  const urlMatch = value.match(/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/)
  if (urlMatch?.[1]) {
    return parseInt(urlMatch[1], 10)
  }
  return null
}
type Props = {
  commands: Command[]
  worktreePaths: string[]
  initialTools: Tool[]
  mcpClients?: MCPServerConnection[]
  dynamicMcpConfig?: Record<string, ScopedMcpServerConfig>
  debug: boolean
  mainThreadAgentDefinition?: AgentDefinition
  autoConnectIdeFlag?: boolean
  strictMcpConfig?: boolean
  systemPrompt?: string
  appendSystemPrompt?: string
  initialSearchQuery?: string
  disableSlashCommands?: boolean
  forkSession?: boolean
  taskListId?: string
  filterByPr?: boolean | number | string
  thinkingConfig: ThinkingConfig
  onTurnComplete?: (messages: Message[]) => void | Promise<void>
}
export function ResumeConversation({
  commands,
  worktreePaths,
  initialTools,
  mcpClients,
  dynamicMcpConfig,
  debug,
  mainThreadAgentDefinition,
  autoConnectIdeFlag,
  strictMcpConfig = false,
  systemPrompt,
  appendSystemPrompt,
  initialSearchQuery,
  disableSlashCommands = false,
  forkSession,
  taskListId,
  filterByPr,
  thinkingConfig,
  onTurnComplete,
}: Props): React.ReactNode {
  const { rows } = useTerminalSize()
  const agentDefinitions = useAppState((s) => s.agentDefinitions)
  const setAppState = useSetAppState()
  const [logs, setLogs] = React.useState<LogOption[]>([])
  const [loading, setLoading] = React.useState(true)
  const [resuming, setResuming] = React.useState(false)
  const [showAllProjects, setShowAllProjects] = React.useState(false)
  const [resumeData, setResumeData] = React.useState<{
    messages: Message[]
    fileHistorySnapshots?: FileHistorySnapshot[]
    contentReplacements?: ContentReplacementRecord[]
    agentName?: string
    agentColor?: AgentColorName
    mainThreadAgentDefinition?: AgentDefinition
  } | null>(null)
  const [crossProjectCommand, setCrossProjectCommand] = React.useState<string | null>(null)
  const sessionLogResultRef = React.useRef<SessionLogResult | null>(null)
  // Mirror of logs.length so loadMoreLogs can compute value indices outside
  // the setLogs updater (keeping it pure per React's contract).
  const logCountRef = React.useRef(0)
  const filteredLogs = React.useMemo(() => {
    let result = logs.filter((l) => !l.isSidechain)
    if (filterByPr !== undefined) {
      if (filterByPr === true) {
        result = result.filter((l_0) => l_0.prNumber !== undefined)
      } else if (typeof filterByPr === 'number') {
        result = result.filter((l_1) => l_1.prNumber === filterByPr)
      } else if (typeof filterByPr === 'string') {
        const prNumber = parsePrIdentifier(filterByPr)
        if (prNumber !== null) {
          result = result.filter((l_2) => l_2.prNumber === prNumber)
        }
      }
    }
    return result
  }, [logs, filterByPr])
  const isResumeWithRenameEnabled = isCustomTitleEnabled()
  React.useEffect(() => {
    loadSameRepoMessageLogsProgressive(worktreePaths)
      .then((result_0) => {
        sessionLogResultRef.current = result_0
        logCountRef.current = result_0.logs.length
        setLogs(result_0.logs)
        setLoading(false)
      })
      .catch((error) => {
        logError(error)
        setLoading(false)
      })
  }, [worktreePaths])
  const loadMoreLogs = React.useCallback((count: number) => {
    const ref = sessionLogResultRef.current
    if (!ref || ref.nextIndex >= ref.allStatLogs.length) {
      return
    }
    void enrichLogs(ref.allStatLogs, ref.nextIndex, count).then((result_1) => {
      ref.nextIndex = result_1.nextIndex
      if (result_1.logs.length > 0) {
        // enrichLogs returns fresh unshared objects — safe to mutate in place.
        // Offset comes from logCountRef so the setLogs updater stays pure.
        const offset = logCountRef.current
        result_1.logs.forEach((log, i) => {
          log.value = offset + i
        })
        setLogs((prev) => prev.concat(result_1.logs))
        logCountRef.current += result_1.logs.length
      } else if (ref.nextIndex < ref.allStatLogs.length) {
        loadMoreLogs(count)
      }
    })
  }, [])
  const loadLogs = React.useCallback(
    (allProjects: boolean) => {
      setLoading(true)
      const promise = allProjects
        ? loadAllProjectsMessageLogsProgressive()
        : loadSameRepoMessageLogsProgressive(worktreePaths)
      promise
        .then((result_2) => {
          sessionLogResultRef.current = result_2
          logCountRef.current = result_2.logs.length
          setLogs(result_2.logs)
        })
        .catch((error_0) => {
          logError(error_0)
        })
        .finally(() => {
          setLoading(false)
        })
    },
    [worktreePaths],
  )
  const handleToggleAllProjects = React.useCallback(() => {
    const newValue = !showAllProjects
    setShowAllProjects(newValue)
    loadLogs(newValue)
  }, [showAllProjects, loadLogs])
  function onCancel() {
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(1)
  }
  async function onSelect(log_0: LogOption) {
    setResuming(true)
    const resumeStart = performance.now()
    const crossProjectCheck = checkCrossProjectResume(log_0, showAllProjects, worktreePaths)
    if (crossProjectCheck.isCrossProject) {
      if (!crossProjectCheck.isSameRepoWorktree) {
        const raw = await setClipboard(crossProjectCheck.command)
        if (raw) {
          process.stdout.write(raw)
        }
        setCrossProjectCommand(crossProjectCheck.command)
        return
      }
    }
    try {
      const result_3 = await loadConversationForResume(log_0, undefined)
      if (!result_3) {
        throw new Error('Failed to load conversation')
      }
      if (feature('COORDINATOR_MODE')) {
        /* eslint-disable @typescript-eslint/no-require-imports */
        const coordinatorModule =
          require('../coordinator/coordinatorMode.js') as typeof import('../coordinator/coordinatorMode.js')
        /* eslint-enable @typescript-eslint/no-require-imports */
        const warning = coordinatorModule.matchSessionMode(result_3.mode)
        if (warning) {
          /* eslint-disable @typescript-eslint/no-require-imports */
          const { getAgentDefinitionsWithOverrides, getActiveAgentsFromList } =
            require('../tools/AgentTool/loadAgentsDir.js') as typeof import('../tools/AgentTool/loadAgentsDir.js')
          /* eslint-enable @typescript-eslint/no-require-imports */
          getAgentDefinitionsWithOverrides.cache.clear?.()
          const freshAgentDefs = await getAgentDefinitionsWithOverrides(getOriginalCwd())
          setAppState((prevState) => ({
            ...prevState,
            agentDefinitions: {
              ...freshAgentDefs,
              allAgents: freshAgentDefs.allAgents,
              activeAgents: getActiveAgentsFromList(freshAgentDefs.allAgents),
            },
          }))
          result_3.messages.push(createSystemMessage(warning, 'warning'))
        }
      }
      if (result_3.sessionId && !forkSession) {
        switchSession(
          asSessionId(result_3.sessionId),
          log_0.fullPath ? dirname(log_0.fullPath) : null,
        )
        await renameRecordingForSession()
        await resetSessionFilePointer()
        restoreCostStateForSession(result_3.sessionId, result_3.messages)
      } else if (forkSession && result_3.contentReplacements?.length) {
        await recordContentReplacement(result_3.contentReplacements)
      }
      const { agentDefinition: resolvedAgentDef } = restoreAgentFromSession(
        result_3.agentSetting,
        mainThreadAgentDefinition,
        agentDefinitions,
      )
      setAppState((prevState) => ({
        ...prevState,
        agent: resolvedAgentDef?.agentType,
      }))
      if (feature('COORDINATOR_MODE')) {
        /* eslint-disable @typescript-eslint/no-require-imports */
        const { saveMode } = require('../services/sessionStorage.js')
        const { isCoordinatorMode } =
          require('../coordinator/coordinatorMode.js') as typeof import('../coordinator/coordinatorMode.js')
        /* eslint-enable @typescript-eslint/no-require-imports */
        saveMode(isCoordinatorMode() ? 'coordinator' : 'normal')
      }
      const standaloneAgentContext = computeStandaloneAgentContext(
        result_3.agentName,
        result_3.agentColor,
      )
      if (standaloneAgentContext) {
        setAppState((prevState) => ({
          ...prevState,
          standaloneAgentContext,
        }))
      }
      void updateSessionName(result_3.agentName)
      restoreSessionMetadata(
        forkSession
          ? {
              ...result_3,
              worktreeSession: undefined,
            }
          : result_3,
      )
      if (!forkSession) {
        restoreWorktreeForResume(result_3.worktreeSession)
        if (result_3.sessionId) {
          adoptResumedSessionFile()
        }
      }
      if (feature('CONTEXT_COLLAPSE')) {
        /* eslint-disable @typescript-eslint/no-require-imports */

        ;(
          require('../services/compact/context-collapse/persist.js') as typeof import('../services/compact/context-collapse/persist.js')
        ).restoreFromEntries(
          result_3.contextCollapseCommits ?? [],
          result_3.contextCollapseSnapshot,
        )
        /* eslint-enable @typescript-eslint/no-require-imports */
      }
      logEvent('zy_session_resumed', {
        entrypoint: 'picker' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        success: true,
        resume_duration_ms: Math.round(performance.now() - resumeStart),
      })
      setLogs([])
      setResumeData({
        messages: result_3.messages,
        fileHistorySnapshots: result_3.fileHistorySnapshots,
        contentReplacements: result_3.contentReplacements,
        agentName: result_3.agentName,
        agentColor: (result_3.agentColor === 'default' ? undefined : result_3.agentColor) as
          | AgentColorName
          | undefined,
        mainThreadAgentDefinition: resolvedAgentDef,
      })
    } catch (e) {
      logEvent('zy_session_resumed', {
        entrypoint: 'picker' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        success: false,
      })
      logError(e as Error)
      throw e
    }
  }
  if (crossProjectCommand) {
    return <CrossProjectMessage command={crossProjectCommand} />
  }
  if (resumeData) {
    return (
      <REPL
        debug={debug}
        commands={commands}
        initialTools={initialTools}
        initialMessages={resumeData.messages}
        initialFileHistorySnapshots={resumeData.fileHistorySnapshots}
        initialContentReplacements={resumeData.contentReplacements}
        initialAgentName={resumeData.agentName}
        initialAgentColor={resumeData.agentColor}
        mcpClients={mcpClients}
        dynamicMcpConfig={dynamicMcpConfig}
        strictMcpConfig={strictMcpConfig}
        systemPrompt={systemPrompt}
        appendSystemPrompt={appendSystemPrompt}
        mainThreadAgentDefinition={resumeData.mainThreadAgentDefinition}
        autoConnectIdeFlag={autoConnectIdeFlag}
        disableSlashCommands={disableSlashCommands}
        taskListId={taskListId}
        thinkingConfig={thinkingConfig}
        onTurnComplete={onTurnComplete}
      />
    )
  }
  if (loading) {
    return (
      <Box>
        <Spinner />
        <Text> {tSync('resume.loading')}</Text>
      </Box>
    )
  }
  if (resuming) {
    return (
      <Box>
        <Spinner />
        <Text> {tSync('resume.resuming')}</Text>
      </Box>
    )
  }
  if (filteredLogs.length === 0) {
    return <NoConversationsMessage />
  }
  return (
    <LogSelector
      logs={filteredLogs}
      maxHeight={rows}
      forceWidth={undefined}
      onCancel={onCancel}
      onSelect={onSelect}
      onLogsChanged={isResumeWithRenameEnabled ? () => loadLogs(showAllProjects) : undefined}
      onLoadMore={loadMoreLogs}
      initialSearchQuery={initialSearchQuery}
      showAllProjects={showAllProjects}
      onToggleAllProjects={handleToggleAllProjects}
      onAgenticSearch={agenticSessionSearch}
    />
  )
}
function NoConversationsMessage() {
  useKeybinding(
    'app:interrupt',
    () => {
      process.exit(1)
    },
    {
      context: 'Global',
    },
  )
  return (
    <Box flexDirection="column">
      <Text>{tSync('resume.noConversations')}</Text>
      <Text dimColor={true}>{tSync('resume.exitHint')}</Text>
    </Box>
  )
}
function CrossProjectMessage({ command }: { command: string }) {
  React.useEffect(() => {
    const timeout = setTimeout(() => {
      process.exit(0)
    }, 100)
    return () => clearTimeout(timeout)
  }, [])
  return (
    <Box flexDirection="column" gap={1}>
      {<Text>{tSync('resume.crossProject')}</Text>}
      {
        <Box flexDirection="column">
          {<Text>{tSync('resume.crossProjectCommand')}</Text>}
          <Text> {command}</Text>
        </Box>
      }
      {<Text dimColor={true}>（{tSync('resume.commandCopied')}）</Text>}
    </Box>
  )
}
