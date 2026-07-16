import * as React from 'react'
import type { SettingSource } from 'src/services/settings/constants.js'
import { POINTER, WARNING } from '../../constants/figures.js'
import { tSync } from '../../i18n/index.js'
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js'
import { Box, Text } from '../../ink/index.js'
import type { ResolvedAgent } from '../../tools/AgentTool/agentDisplay.js'
import {
  AGENT_SOURCE_GROUPS,
  compareAgentsByName,
  getOverrideSourceLabel,
  resolveAgentModelDisplay,
} from '../../tools/AgentTool/agentDisplay.js'
import type { AgentDefinition } from '../../tools/AgentTool/loadAgentsDir.js'
import { count } from '../../utils/array.js'
import { Dialog } from '../design-system/Dialog.js'
import { Divider } from '../design-system/Divider.js'
import { getAgentSourceDisplayName } from './utils.js'

type Props = {
  source: SettingSource | 'all' | 'built-in' | 'plugin'
  agents: ResolvedAgent[]
  onBack: () => void
  onSelect: (agent: AgentDefinition) => void
  onCreateNew?: () => void
  changes?: string[]
}
export function AgentsList({ source, agents, onBack, onSelect, onCreateNew, changes }: Props) {
  const [selectedAgent, setSelectedAgent] = React.useState<ResolvedAgent | null>(null)
  const [isCreateNewSelected, setIsCreateNewSelected] = React.useState(true)
  const sortedAgents = [...agents].sort(compareAgentsByName)
  const getOverrideInfo = (agent: ResolvedAgent) => ({
    isOverridden: !!agent.overriddenBy,
    overriddenBy: agent.overriddenBy || null,
  })
  const renderCreateNewOption = () => (
    <Box>
      <Text color={isCreateNewSelected ? 'suggestion' : undefined}>
        {isCreateNewSelected ? `${POINTER} ` : '  '}
      </Text>
      <Text color={isCreateNewSelected ? 'suggestion' : undefined}>
        {tSync('agents.createNewAgent')}
      </Text>
    </Box>
  )
  const renderAgent = (agent_0: ResolvedAgent) => {
    const isBuiltIn = agent_0.source === 'built-in'
    const isSelected =
      !isBuiltIn &&
      !isCreateNewSelected &&
      selectedAgent?.agentType === agent_0.agentType &&
      selectedAgent?.source === agent_0.source
    const { isOverridden, overriddenBy } = getOverrideInfo(agent_0)
    const dimmed = isBuiltIn || isOverridden
    const textColor = !isBuiltIn && isSelected ? 'suggestion' : undefined
    const resolvedModel = resolveAgentModelDisplay(agent_0)
    return (
      <Box key={`${agent_0.agentType}-${agent_0.source}`}>
        <Text dimColor={dimmed && !isSelected} color={textColor}>
          {isBuiltIn ? '' : isSelected ? `${POINTER} ` : '  '}
        </Text>
        <Text dimColor={dimmed && !isSelected} color={textColor}>
          {agent_0.agentType}
        </Text>
        {resolvedModel && (
          <Text dimColor={true} color={textColor}>
            {' \xB7 '}
            {resolvedModel}
          </Text>
        )}
        {agent_0.memory && (
          <Text dimColor={true} color={textColor}>
            {' \xB7 '}
            {tSync('agents.memoryLabel', { memory: agent_0.memory })}
          </Text>
        )}
        {overriddenBy && (
          <Text dimColor={!isSelected} color={isSelected ? 'warning' : undefined}>
            {' '}
            {WARNING} {tSync('agents.shadowedBy', { source: getOverrideSourceLabel(overriddenBy) })}
          </Text>
        )}
      </Box>
    )
  }
  let selectableAgentsInOrder
  const nonBuiltIn = sortedAgents.filter((a) => a.source !== 'built-in')
  if (source === 'all') {
    selectableAgentsInOrder = AGENT_SOURCE_GROUPS.filter((g) => g.source !== 'built-in').flatMap(
      (group) => {
        const { source: groupSource } = group
        return nonBuiltIn.filter((a_0) => a_0.source === groupSource)
      },
    )
  } else {
    selectableAgentsInOrder = nonBuiltIn
  }
  React.useEffect(() => {
    if (!selectedAgent && !isCreateNewSelected && selectableAgentsInOrder.length > 0) {
      if (onCreateNew) {
        setIsCreateNewSelected(true)
      } else {
        setSelectedAgent(selectableAgentsInOrder[0] || null)
      }
    }
  }, [selectableAgentsInOrder, selectedAgent, isCreateNewSelected, onCreateNew])
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'return') {
      e.preventDefault()
      if (isCreateNewSelected && onCreateNew) {
        onCreateNew()
      } else {
        if (selectedAgent) {
          onSelect(selectedAgent)
        }
      }
      return
    }
    if (e.key !== 'up' && e.key !== 'down') {
      return
    }
    e.preventDefault()
    const hasCreateOption = !!onCreateNew
    const totalItems = selectableAgentsInOrder.length + (hasCreateOption ? 1 : 0)
    if (totalItems === 0) {
      return
    }
    let currentPosition = 0
    if (!isCreateNewSelected && selectedAgent) {
      const agentIndex = selectableAgentsInOrder.findIndex(
        (a_1) => a_1.agentType === selectedAgent.agentType && a_1.source === selectedAgent.source,
      )
      if (agentIndex >= 0) {
        currentPosition = hasCreateOption ? agentIndex + 1 : agentIndex
      }
    }
    const newPosition =
      e.key === 'up'
        ? currentPosition === 0
          ? totalItems - 1
          : currentPosition - 1
        : currentPosition === totalItems - 1
          ? 0
          : currentPosition + 1
    if (hasCreateOption && newPosition === 0) {
      setIsCreateNewSelected(true)
      setSelectedAgent(null)
    } else {
      const agentIndex_0 = hasCreateOption ? newPosition - 1 : newPosition
      const newAgent = selectableAgentsInOrder[agentIndex_0]
      if (newAgent) {
        setIsCreateNewSelected(false)
        setSelectedAgent(newAgent)
      }
    }
  }
  const renderBuiltInAgentsSection = (titleText: string | undefined) => {
    const title =
      titleText === undefined
        ? `${tSync('agents.builtInAgents')} ${tSync('agents.builtInAlwaysAvailable')}`
        : titleText
    const builtInAgents = sortedAgents.filter((a_2) => a_2.source === 'built-in')
    return (
      <Box flexDirection="column" marginBottom={1} paddingLeft={2}>
        <Text bold={true} dimColor={true}>
          {title}
        </Text>
        {builtInAgents.map(renderAgent)}
      </Box>
    )
  }
  const renderAgentGroup = (title_0: string, groupAgents: ResolvedAgent[]) => {
    if (!groupAgents.length) {
      return null
    }
    const folderPath = groupAgents[0]?.baseDir
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Box paddingLeft={2}>
          <Text bold={true} dimColor={true}>
            {title_0}
          </Text>
          {folderPath && <Text dimColor={true}> ({folderPath})</Text>}
        </Box>
        {groupAgents.map((agent_1) => renderAgent(agent_1))}
      </Box>
    )
  }
  const sourceTitle = getAgentSourceDisplayName(source)
  const builtInAgents_0 = sortedAgents.filter((a_3) => a_3.source === 'built-in')
  const hasNoAgents =
    !sortedAgents.length ||
    (source !== 'built-in' && !sortedAgents.some((a_4) => a_4.source !== 'built-in'))
  if (hasNoAgents) {
    const fragmentContent2 = source !== 'built-in' &&
      sortedAgents.some((a_5) => a_5.source === 'built-in') && (
        <>
          <Divider padding={4} />
          {renderBuiltInAgentsSection(undefined)}
        </>
      )
    return (
      <Dialog
        title={sourceTitle}
        subtitle={tSync('agents.noAgentsFound')}
        onCancel={onBack}
        hideInputGuide={true}
      >
        {
          <Box
            flexDirection="column"
            gap={1}
            tabIndex={0}
            autoFocus={true}
            onKeyDown={handleKeyDown}
          >
            {onCreateNew && <Box>{renderCreateNewOption()}</Box>}
            {<Text dimColor={true}>{tSync('agents.noAgentsHelpLine1')}</Text>}
            {<Text dimColor={true}>{tSync('agents.noAgentsHelpLine2')}</Text>}
            {<Text dimColor={true}>{tSync('agents.noAgentsTryCreating')}</Text>}
            {fragmentContent2}
          </Box>
        }
      </Dialog>
    )
  }

  const DialogComponent = Dialog
  const dialogTitle = sourceTitle
  const countResult = count(sortedAgents, (a_6) => !a_6.overriddenBy)
  const agentsCountText = tSync('agents.agentsCount', { count: countResult })
  const handleBack = onBack

  const boxElement = changes && changes.length > 0 && (
    <Box marginTop={1}>
      <Text dimColor={true}>{changes[changes.length - 1]}</Text>
    </Box>
  )
  const BoxComponent = Box

  const handleKeyDownCallback = handleKeyDown
  const boxElement2 = onCreateNew && <Box marginBottom={1}>{renderCreateNewOption()}</Box>
  const fragmentContent =
    source === 'all' ? (
      <>
        {AGENT_SOURCE_GROUPS.filter((g_0) => g_0.source !== 'built-in').map((groupConfig) => {
          const { label, source: groupSource_0 } = groupConfig
          return (
            <React.Fragment key={groupSource_0}>
              {renderAgentGroup(
                tSync(label),
                sortedAgents.filter((a_7) => a_7.source === groupSource_0),
              )}
            </React.Fragment>
          )
        })}
        {builtInAgents_0.length > 0 && (
          <Box flexDirection="column" marginBottom={1} paddingLeft={2}>
            <Text dimColor={true}>
              <Text bold={true}>{tSync('agents.builtInAgents')}</Text>{' '}
              {tSync('agents.builtInAlwaysAvailable')}
            </Text>
            {builtInAgents_0.map(renderAgent)}
          </Box>
        )}
      </>
    ) : source === 'built-in' ? (
      <>
        <Text dimColor={true} italic={true}>
          {tSync('agents.builtInAgentsDesc')}
        </Text>
        <Box marginTop={1} flexDirection="column">
          {sortedAgents.map((agent_2) => renderAgent(agent_2))}
        </Box>
      </>
    ) : (
      <>
        {sortedAgents
          .filter((a_8) => a_8.source !== 'built-in')
          .map((agent_3) => renderAgent(agent_3))}
        {sortedAgents.some((a_9) => a_9.source === 'built-in') && (
          <>
            <Divider padding={4} />
            {renderBuiltInAgentsSection(undefined)}
          </>
        )}
      </>
    )

  return (
    <DialogComponent
      title={dialogTitle}
      subtitle={agentsCountText}
      onCancel={handleBack}
      hideInputGuide={true}
    >
      {boxElement}
      {
        <BoxComponent
          flexDirection={'column'}
          tabIndex={0}
          autoFocus={true}
          onKeyDown={handleKeyDownCallback}
        >
          {boxElement2}
          {fragmentContent}
        </BoxComponent>
      }
    </DialogComponent>
  )
}
