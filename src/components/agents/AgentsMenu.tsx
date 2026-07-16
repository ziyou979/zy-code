import chalk from 'chalk'
import { useState } from 'react'
import type { CommandResultDisplay } from '../../commands/index.js'
import { useExitOnCtrlCDWithKeybindings } from '../../hooks/useExitOnCtrlCDWithKeybindings.js'
import { useMergedTools } from '../../hooks/useMergedTools.js'
import { tSync } from '../../i18n/index.js'
import { Box, Text } from '../../ink/index.js'
import { useAppState, useSetAppState } from '../../state/AppState.js'
import type { Tools } from '../../tools/Tool.js'
import { resolveAgentOverrides } from '../../tools/AgentTool/agentDisplay.js'
import {
  type AgentDefinition,
  getActiveAgentsFromList,
} from '../../tools/AgentTool/loadAgentsDir.js'
import { toError } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import type { SettingSource } from '../../services/settings/constants.js'
import { Select } from '../CustomSelect/select.js'
import { Dialog } from '../design-system/Dialog.js'
import { AgentDetail } from './AgentDetail.js'
import { AgentEditor } from './AgentEditor.js'
import { AgentNavigationFooter } from './AgentNavigationFooter.js'
import { AgentsList } from './AgentsList.js'
import { deleteAgentFromFile } from './agentFileUtils.js'
import { CreateAgentWizard } from './new-agent-creation/CreateAgentWizard.js'

type Props = {
  tools: Tools
  onExit: (
    result?: string,
    options?: {
      display?: CommandResultDisplay
    },
  ) => void
}

type AgentSource = SettingSource | 'built-in' | 'plugin'

type ModeState =
  | { mode: 'list-agents'; source: AgentSource | 'all' }
  | { mode: 'create-agent' }
  // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
  | { mode: 'agent-menu'; agent: any; previousMode: ModeState }
  // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
  | { mode: 'view-agent'; agent: any; previousMode: ModeState }
  // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
  | { mode: 'edit-agent'; agent: any; previousMode: ModeState }
  // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
  | { mode: 'delete-confirm'; agent: any; previousMode: ModeState }

export function AgentsMenu({ tools, onExit }: Props) {
  const [modeState, setModeState] = useState<ModeState>({
    mode: 'list-agents',
    source: 'all' as const,
  })
  const agentDefinitions = useAppState((s) => s.agentDefinitions)
  const mcpTools = useAppState((s) => s.mcp.tools)
  const toolPermissionContext = useAppState((s) => s.toolPermissionContext)
  const setAppState = useSetAppState()
  const { allAgents, activeAgents: agents } = agentDefinitions
  const [changes, setChanges] = useState<string[]>([])
  const mergedTools = useMergedTools(tools, mcpTools, toolPermissionContext)
  useExitOnCtrlCDWithKeybindings()
  const builtInAgents = allAgents.filter((agent) => agent.source === 'built-in')
  const userSettingAgents = allAgents.filter((agent) => agent.source === 'userSettings')
  const projectSettingAgents = allAgents.filter((agent) => agent.source === 'projectSettings')
  const policySettingAgents = allAgents.filter((agent) => agent.source === 'policySettings')
  const localSettingAgents = allAgents.filter((agent) => agent.source === 'localSettings')
  const flagSettingAgents = allAgents.filter((agent) => agent.source === 'flagSettings')
  const pluginAgents = allAgents.filter((agent) => agent.source === 'plugin')
  const agentsBySource = {
    'built-in': builtInAgents,
    userSettings: userSettingAgents,
    projectSettings: projectSettingAgents,
    policySettings: policySettingAgents,
    localSettings: localSettingAgents,
    flagSettings: flagSettingAgents,
    plugin: pluginAgents,
    all: allAgents,
  }
  const handleAgentCreated = (message: string) => {
    setChanges((prev) => [...prev, message])
    setModeState({
      mode: 'list-agents',
      source: 'all',
    })
  }
  const handleAgentDeleted = async (agentToDelete: AgentDefinition) => {
    try {
      await deleteAgentFromFile(agentToDelete)
      setAppState((state) => {
        const filteredAgents = state.agentDefinitions.allAgents.filter(
          (agent) =>
            !(agent.agentType === agentToDelete.agentType && agent.source === agentToDelete.source),
        )
        return {
          ...state,
          agentDefinitions: {
            ...state.agentDefinitions,
            allAgents: filteredAgents,
            activeAgents: getActiveAgentsFromList(filteredAgents),
          },
        }
      })
      setChanges((prev_0) => [
        ...prev_0,
        tSync('agents.deletedAgent', { name: chalk.bold(agentToDelete.agentType) }),
      ])
      setModeState({
        mode: 'list-agents',
        source: 'all',
      })
    } catch (error) {
      logError(toError(error))
    }
  }
  switch (modeState.mode) {
    case 'list-agents': {
      const agentsToShow =
        modeState.source === 'all'
          ? [
              ...agentsBySource['built-in'],
              ...agentsBySource.userSettings,
              ...agentsBySource.projectSettings,
              ...agentsBySource.localSettings,
              ...agentsBySource.policySettings,
              ...agentsBySource.flagSettings,
              ...agentsBySource.plugin,
            ]
          : agentsBySource[modeState.source]
      const resolvedAgents = resolveAgentOverrides(agentsToShow, agents)
      const handleExit = () => {
        const exitMessage =
          changes.length > 0 ? tSync('agents.changes', { changes: changes.join('\n') }) : undefined
        onExit(exitMessage ?? tSync('agents.dialogDismissed'), {
          display: changes.length === 0 ? 'system' : undefined,
        })
      }
      const handleSelectAgent = (agent: AgentDefinition) =>
        setModeState({
          mode: 'agent-menu',
          agent,
          previousMode: modeState,
        })
      const handleCreateNew = () =>
        setModeState({
          mode: 'create-agent',
        })
      const agentList = (
        <AgentsList
          source={modeState.source}
          agents={resolvedAgents}
          onBack={handleExit}
          onSelect={handleSelectAgent}
          onCreateNew={handleCreateNew}
          changes={changes}
        />
      )
      const footer = <AgentNavigationFooter />
      return (
        <>
          {agentList}
          {footer}
        </>
      )
    }
    case 'create-agent': {
      const handleCancel = () =>
        setModeState({
          mode: 'list-agents',
          source: 'all',
        })
      return (
        <CreateAgentWizard
          tools={mergedTools}
          existingAgents={agents}
          onComplete={handleAgentCreated}
          onCancel={handleCancel}
        />
      )
    }
    case 'agent-menu': {
      const findAgent = (agent: AgentDefinition) =>
        agent.agentType === modeState.agent.agentType && agent.source === modeState.agent.source
      const freshAgent = allAgents.find(findAgent)
      const agentToUse = freshAgent || modeState.agent
      const isEditable =
        agentToUse.source !== 'built-in' &&
        agentToUse.source !== 'plugin' &&
        agentToUse.source !== 'flagSettings'
      const viewOption = {
        label: tSync('agents.viewAgent'),
        value: 'view',
      }
      const editOptions = isEditable
        ? [
            {
              label: tSync('agents.editAgent'),
              value: 'edit',
            },
            {
              label: tSync('agents.deleteAgent'),
              value: 'delete',
            },
          ]
        : []
      const backOption = {
        label: tSync('agents.back'),
        value: 'back',
      }
      const menuItems = [viewOption, ...editOptions, backOption]
      const handleMenuSelect = (value: string) => {
        switch (value) {
          case 'view': {
            setModeState({
              mode: 'view-agent',
              agent: agentToUse,
              previousMode: modeState.previousMode,
            })
            break
          }
          case 'edit': {
            setModeState({
              mode: 'edit-agent',
              agent: agentToUse,
              previousMode: modeState,
            })
            break
          }
          case 'delete': {
            setModeState({
              mode: 'delete-confirm',
              agent: agentToUse,
              previousMode: modeState,
            })
            break
          }
          case 'back': {
            setModeState(modeState.previousMode)
          }
        }
      }
      const handleBack = () => setModeState(modeState.previousMode)
      const selectComponent = (
        <Select options={menuItems} onChange={handleMenuSelect} onCancel={handleBack} />
      )
      const changeNotice = changes.length > 0 && (
        <Box marginTop={1}>
          <Text dimColor={true}>{changes[changes.length - 1]}</Text>
        </Box>
      )
      const menuContent = (
        <Box flexDirection="column">
          {selectComponent}
          {changeNotice}
        </Box>
      )
      const dialog = (
        <Dialog title={modeState.agent.agentType} onCancel={handleBack} hideInputGuide={true}>
          {menuContent}
        </Dialog>
      )
      const footer = <AgentNavigationFooter />
      return (
        <>
          {dialog}
          {footer}
        </>
      )
    }
    case 'view-agent': {
      const findAgent = (agent: AgentDefinition) =>
        agent.agentType === modeState.agent.agentType && agent.source === modeState.agent.source
      const freshAgent = allAgents.find(findAgent)
      const agentToDisplay = freshAgent || modeState.agent
      const handleCancel = () =>
        setModeState({
          mode: 'agent-menu',
          agent: agentToDisplay,
          previousMode: modeState.previousMode,
        })
      const handleBack = () =>
        setModeState({
          mode: 'agent-menu',
          agent: agentToDisplay,
          previousMode: modeState.previousMode,
        })
      const agentDetail = (
        <AgentDetail agent={agentToDisplay} tools={mergedTools} onBack={handleBack} />
      )
      const dialog = (
        <Dialog title={agentToDisplay.agentType} onCancel={handleCancel} hideInputGuide={true}>
          {agentDetail}
        </Dialog>
      )
      const footer = <AgentNavigationFooter instructions={tSync('agents.pressEnterEscBack')} />
      return (
        <>
          {dialog}
          {footer}
        </>
      )
    }
    case 'delete-confirm': {
      const deleteOptions = [
        {
          label: tSync('agents.deleteYes'),
          value: 'yes',
        },
        {
          label: tSync('agents.deleteNo'),
          value: 'no',
        },
      ]
      const handleCancel = () => {
        if ('previousMode' in modeState) {
          setModeState(modeState.previousMode)
        }
      }
      const confirmText = (
        <Text>{tSync('agents.deleteConfirmQuestion', { name: modeState.agent.agentType })}</Text>
      )
      const sourceInfo = (
        <Box marginTop={1}>
          <Text dimColor={true}>
            {tSync('agents.editor.source', { source: modeState.agent.source })}
          </Text>
        </Box>
      )
      const handleDeleteConfirm = (value: string) => {
        switch (value) {
          case 'yes': {
            handleAgentDeleted(modeState.agent)
            break
          }
          case 'no': {
            setModeState(modeState.previousMode)
          }
        }
      }
      const selectComponent = (
        <Box marginTop={1}>
          <Select options={deleteOptions} onChange={handleDeleteConfirm} onCancel={handleCancel} />
        </Box>
      )
      const dialog = (
        <Dialog title={tSync('agents.deleteConfirmTitle')} onCancel={handleCancel} color="error">
          {confirmText}
          {sourceInfo}
          {selectComponent}
        </Dialog>
      )
      const footer = <AgentNavigationFooter instructions={tSync('agents.navInstructions')} />
      return (
        <>
          {dialog}
          {footer}
        </>
      )
    }
    case 'edit-agent': {
      const findAgent = (agent: AgentDefinition) =>
        agent.agentType === modeState.agent.agentType && agent.source === modeState.agent.source
      const freshAgent = allAgents.find(findAgent)
      const agentToEdit = freshAgent || modeState.agent
      const editTitle = tSync('agents.editAgentTitle', { name: agentToEdit.agentType })
      const handleBack = () => setModeState(modeState.previousMode)
      const handleSaved = (message: string) => {
        handleAgentCreated(message)
        setModeState(modeState.previousMode)
      }
      const editor = (
        <AgentEditor
          agent={agentToEdit}
          tools={mergedTools}
          onSaved={handleSaved}
          onBack={handleBack}
        />
      )
      const dialog = (
        <Dialog title={editTitle} onCancel={handleBack} hideInputGuide={true}>
          {editor}
        </Dialog>
      )
      const footer = <AgentNavigationFooter />
      return (
        <>
          {dialog}
          {footer}
        </>
      )
    }
    default: {
      return null
    }
  }
}
