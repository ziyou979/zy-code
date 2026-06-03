import figures from 'figures'
import React, { useState } from 'react'
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js'
import { mcpInfoFromString } from 'src/services/mcp/mcpStringUtils.js'
import { isMcpTool } from 'src/services/mcp/utils.js'
import type { Tool, Tools } from 'src/Tool.js'
import { filterToolsForAgent } from 'src/tools/AgentTool/agentToolUtils.js'
import { AGENT_TOOL_NAME } from 'src/tools/AgentTool/constants.js'
import { BashTool } from 'src/tools/BashTool/BashTool.js'
import { ExitPlanModeV2Tool } from 'src/tools/ExitPlanModeTool/ExitPlanModeV2Tool.js'
import { FileEditTool } from 'src/tools/FileEditTool/FileEditTool.js'
import { FileReadTool } from 'src/tools/FileReadTool/FileReadTool.js'
import { FileWriteTool } from 'src/tools/FileWriteTool/FileWriteTool.js'
import { GlobTool } from 'src/tools/GlobTool/GlobTool.js'
import { GrepTool } from 'src/tools/GrepTool/GrepTool.js'
import { ListMcpResourcesTool } from 'src/tools/ListMcpResourcesTool/ListMcpResourcesTool.js'
import { NotebookEditTool } from 'src/tools/NotebookEditTool/NotebookEditTool.js'
import { ReadMcpResourceTool } from 'src/tools/ReadMcpResourceTool/ReadMcpResourceTool.js'
import { TaskOutputTool } from 'src/tools/TaskOutputTool/TaskOutputTool.js'
import { TaskStopTool } from 'src/tools/TaskStopTool/TaskStopTool.js'
import { TodoWriteTool } from 'src/tools/TodoWriteTool/TodoWriteTool.js'
import { TungstenTool } from 'src/tools/TungstenTool/TungstenTool.js'
import { WebFetchTool } from 'src/tools/WebFetchTool/WebFetchTool.js'
import { WebSearchTool } from 'src/tools/WebSearchTool/WebSearchTool.js'
import { tSync } from '../../i18n/index.js'
import { Box, Text } from '../../ink.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import { count } from '../../utils/array.js'
import { isInternalBuild } from '../../utils/envUtils.js'
import { Divider } from '../design-system/Divider.js'

type Props = {
  tools: Tools
  initialTools: string[] | undefined
  onComplete: (selectedTools: string[] | undefined) => void
  onCancel?: () => void
}
type ToolBucket = {
  name: string
  toolNames: Set<string>
  isMcp?: boolean
}
type ToolBuckets = {
  READ_ONLY: ToolBucket
  EDIT: ToolBucket
  EXECUTION: ToolBucket
  MCP: ToolBucket
  OTHER: ToolBucket
}
function getToolBuckets(): ToolBuckets {
  return {
    READ_ONLY: {
      name: tSync('agents.toolSelector.readOnlyTools'),
      toolNames: new Set([
        GlobTool.name,
        GrepTool.name,
        ExitPlanModeV2Tool.name,
        FileReadTool.name,
        WebFetchTool.name,
        TodoWriteTool.name,
        WebSearchTool.name,
        TaskStopTool.name,
        TaskOutputTool.name,
        ListMcpResourcesTool.name,
        ReadMcpResourceTool.name,
      ]),
    },
    EDIT: {
      name: tSync('agents.toolSelector.editTools'),
      toolNames: new Set([FileEditTool.name, FileWriteTool.name, NotebookEditTool.name]),
    },
    EXECUTION: {
      name: tSync('agents.toolSelector.executionTools'),
      toolNames: new Set(
        [BashTool.name, isInternalBuild() ? TungstenTool.name : undefined].filter(
          (n) => n !== undefined,
        ),
      ),
    },
    MCP: {
      name: tSync('agents.toolSelector.mcpTools'),
      toolNames: new Set(),
      // Dynamic - no static list
      isMcp: true,
    },
    OTHER: {
      name: tSync('agents.toolSelector.otherTools'),
      toolNames: new Set(), // Dynamic - catch-all for uncategorized tools
    },
  }
}

// Helper to get MCP server buckets dynamically
function getMcpServerBuckets(tools: Tools): Array<{
  serverName: string
  tools: Tools
}> {
  const serverMap = new Map<string, Tool[]>()
  tools.forEach((tool) => {
    if (isMcpTool(tool)) {
      const mcpInfo = mcpInfoFromString(tool.name)
      if (mcpInfo?.serverName) {
        const existing = serverMap.get(mcpInfo.serverName) || []
        existing.push(tool)
        serverMap.set(mcpInfo.serverName, existing)
      }
    }
  })
  return Array.from(serverMap.entries())
    .map(([serverName, tools]) => ({
      serverName,
      tools,
    }))
    .sort((a, b) => a.serverName.localeCompare(b.serverName))
}
export function ToolSelector({ tools, initialTools, onComplete, onCancel }: Props) {
  const customAgentTools = filterToolsForAgent({
    tools,
    isBuiltIn: false,
    isAsync: false,
  })
  const expandedInitialTools =
    !initialTools || initialTools.includes('*') ? customAgentTools.map((t) => t.name) : initialTools
  const [selectedTools, setSelectedTools] = useState(expandedInitialTools)
  const [focusIndex, setFocusIndex] = useState(0)
  const [showIndividualTools, setShowIndividualTools] = useState(false)
  const toolNames = new Set(customAgentTools.map((tool) => tool.name))
  const validSelectedTools = selectedTools.filter((name) => toolNames.has(name))
  const selectedSet = new Set(validSelectedTools)
  const isAllSelected =
    validSelectedTools.length === customAgentTools.length && customAgentTools.length > 0
  const handleToggleTool = (toolName: string) => {
    if (!toolName) {
      return
    }
    setSelectedTools((current) =>
      current.includes(toolName)
        ? current.filter((name) => name !== toolName)
        : [...current, toolName],
    )
  }
  const handleToggleTools = (toolNames_0: string[], select: boolean) => {
    setSelectedTools((current_0) => {
      if (select) {
        const toolsToAdd = toolNames_0.filter((name) => !current_0.includes(name))
        return [...current_0, ...toolsToAdd]
      } else {
        return current_0.filter((name) => !toolNames_0.includes(name))
      }
    })
  }
  const handleConfirm = () => {
    const allToolNames = customAgentTools.map((tool) => tool.name)
    const areAllToolsSelected =
      validSelectedTools.length === allToolNames.length &&
      allToolNames.every((name_0) => validSelectedTools.includes(name_0))
    const finalTools = areAllToolsSelected ? undefined : validSelectedTools
    onComplete(finalTools)
  }
  const toolBuckets = getToolBuckets()
  const buckets = {
    readOnly: [] as Tool[],
    edit: [] as Tool[],
    execution: [] as Tool[],
    mcp: [] as Tool[],
    other: [] as Tool[],
  }
  customAgentTools.forEach((tool) => {
    if (isMcpTool(tool)) {
      buckets.mcp.push(tool)
    } else {
      if (toolBuckets.READ_ONLY.toolNames.has(tool.name)) {
        buckets.readOnly.push(tool)
      } else {
        if (toolBuckets.EDIT.toolNames.has(tool.name)) {
          buckets.edit.push(tool)
        } else {
          if (toolBuckets.EXECUTION.toolNames.has(tool.name)) {
            buckets.execution.push(tool)
          } else {
            if (tool.name !== AGENT_TOOL_NAME) {
              buckets.other.push(tool)
            }
          }
        }
      }
    }
  })
  const toolsByBucket = buckets
  const createBucketToggleAction = (bucketTools: Tool[]) => {
    const selected = count(bucketTools, (tool: any) => selectedSet.has(tool.name))
    const needsSelection = selected < bucketTools.length
    return () => {
      const toolNames_1 = bucketTools.map((tool: any) => tool.name)
      handleToggleTools(toolNames_1, needsSelection)
    }
  }
  const navigableItems: Array<{
    id: string
    label: string
    action: () => void
    isContinue?: boolean
    isToggle?: boolean
    isHeader?: boolean
  }> = []
  navigableItems.push({
    id: 'continue',
    label: tSync('agents.toolSelector.continue'),
    action: handleConfirm,
    isContinue: true,
  })
  navigableItems.push({
    id: 'bucket-all',
    label: `${isAllSelected ? figures.checkboxOn : figures.checkboxOff} ${tSync('agents.toolSelector.allTools')}`,
    action: () => {
      const allToolNames_0 = customAgentTools.map((tool) => tool.name)
      handleToggleTools(allToolNames_0, !isAllSelected)
    },
  })
  const toolBuckets_0 = getToolBuckets()
  const bucketConfigs = [
    {
      id: 'bucket-readonly',
      name: toolBuckets_0.READ_ONLY.name,
      tools: toolsByBucket.readOnly,
    },
    {
      id: 'bucket-edit',
      name: toolBuckets_0.EDIT.name,
      tools: toolsByBucket.edit,
    },
    {
      id: 'bucket-execution',
      name: toolBuckets_0.EXECUTION.name,
      tools: toolsByBucket.execution,
    },
    {
      id: 'bucket-mcp',
      name: toolBuckets_0.MCP.name,
      tools: toolsByBucket.mcp,
    },
    {
      id: 'bucket-other',
      name: toolBuckets_0.OTHER.name,
      tools: toolsByBucket.other,
    },
  ]
  bucketConfigs.forEach((bucketConfig) => {
    const { id, name: name_1, tools: bucketTools_0 } = bucketConfig
    if (bucketTools_0.length === 0) {
      return
    }
    const selected_0 = count(bucketTools_0, (tool) => selectedSet.has(tool.name))
    const isFullySelected = selected_0 === bucketTools_0.length
    navigableItems.push({
      id,
      label: `${isFullySelected ? figures.checkboxOn : figures.checkboxOff} ${name_1}`,
      action: createBucketToggleAction(bucketTools_0),
    })
  })
  const toggleButtonIndex = navigableItems.length
  navigableItems.push({
    id: 'toggle-individual',
    label: showIndividualTools
      ? tSync('agents.toolSelector.hideAdvanced')
      : tSync('agents.toolSelector.showAdvanced'),
    action: () => {
      setShowIndividualTools(!showIndividualTools)
      if (showIndividualTools && focusIndex > toggleButtonIndex) {
        setFocusIndex(toggleButtonIndex)
      }
    },
    isToggle: true,
  })
  const mcpServerBuckets = getMcpServerBuckets(customAgentTools)
  if (showIndividualTools) {
    if (mcpServerBuckets.length > 0) {
      navigableItems.push({
        id: 'mcp-servers-header',
        label: tSync('agents.toolSelector.mcpServersHeader'),
        action: _temp6,
        isHeader: true,
      })
      mcpServerBuckets.forEach((serverBucket) => {
        const { serverName, tools: serverTools } = serverBucket
        const selected_1 = count(serverTools, (tool) => selectedSet.has(tool.name))
        const isFullySelected_0 = selected_1 === serverTools.length
        navigableItems.push({
          id: `mcp-server-${serverName}`,
          label: `${isFullySelected_0 ? figures.checkboxOn : figures.checkboxOff} ${serverName} (${serverTools.length} ${tSync('agents.toolSelector.toolCount', { count: serverTools.length })})`,
          action: () => {
            const toolNames_2 = serverTools.map((tool) => tool.name)
            handleToggleTools(toolNames_2, !isFullySelected_0)
          },
        })
      })
      navigableItems.push({
        id: 'tools-header',
        label: tSync('agents.toolSelector.individualToolsHeader'),
        action: _temp8,
        isHeader: true,
      })
    }
    customAgentTools.forEach((tool_0) => {
      let displayName = tool_0.name
      if (tool_0.name.startsWith('mcp__')) {
        const mcpInfo = mcpInfoFromString(tool_0.name)
        displayName = mcpInfo ? `${mcpInfo.toolName} (${mcpInfo.serverName})` : tool_0.name
      }
      navigableItems.push({
        id: `tool-${tool_0.name}`,
        label: `${selectedSet.has(tool_0.name) ? figures.checkboxOn : figures.checkboxOff} ${displayName}`,
        action: () => handleToggleTool(tool_0.name),
      })
    })
  }
  const handleCancel = () => {
    if (onCancel) {
      onCancel()
    } else {
      onComplete(initialTools)
    }
  }
  useKeybinding('confirm:no', handleCancel, {
    context: 'Confirmation',
  })
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'return') {
      e.preventDefault()
      const item = navigableItems[focusIndex]
      if (item && !item.isHeader) {
        item.action()
      }
    } else {
      if (e.key === 'up') {
        e.preventDefault()
        let newIndex = focusIndex - 1
        while (newIndex > 0 && navigableItems[newIndex]?.isHeader) {
          newIndex--
        }
        setFocusIndex(Math.max(0, newIndex))
      } else {
        if (e.key === 'down') {
          e.preventDefault()
          let newIndex_0 = focusIndex + 1
          while (newIndex_0 < navigableItems.length - 1 && navigableItems[newIndex_0]?.isHeader) {
            newIndex_0++
          }
          setFocusIndex(Math.min(navigableItems.length - 1, newIndex_0))
        }
      }
    }
  }
  const visibleItems = navigableItems.slice(1)
  const renderedItems = visibleItems.map((item_0, index) => {
    const isCurrentlyFocused = index + 1 === focusIndex
    const isToggleButton = item_0.isToggle
    const isHeader = item_0.isHeader
    return (
      <React.Fragment key={item_0.id}>
        {isToggleButton && <Divider width={40} />}
        {isHeader && index > 0 && <Box marginTop={1} />}
        <Text
          color={isHeader ? undefined : isCurrentlyFocused ? 'suggestion' : undefined}
          dimColor={isHeader}
          bold={isToggleButton && isCurrentlyFocused}
        >
          {isHeader ? '' : isCurrentlyFocused ? `${figures.pointer} ` : '  '}
          {isToggleButton ? `[ ${item_0.label} ]` : item_0.label}
        </Text>
      </React.Fragment>
    )
  })
  return (
    <Box
      flexDirection="column"
      marginTop={1}
      tabIndex={0}
      autoFocus={true}
      onKeyDown={handleKeyDown}
    >
      {
        <Text color={focusIndex === 0 ? 'suggestion' : undefined} bold={focusIndex === 0}>
          {focusIndex === 0 ? `${figures.pointer} ` : '  '}[ {tSync('agents.toolSelector.continue')}{' '}
          ]
        </Text>
      }
      {<Divider width={40} />}
      {renderedItems}
      {
        <Box marginTop={1} flexDirection="column">
          <Text dimColor={true}>
            {isAllSelected
              ? tSync('agents.toolSelector.allSelected')
              : tSync('agents.toolSelector.selectedCount', {
                  selected: selectedSet.size,
                  total: customAgentTools.length,
                })}
          </Text>
        </Box>
      }
    </Box>
  )
}
function _temp8() {}
function _temp6() {}
