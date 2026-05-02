import React from 'react'
import { tSync } from 'src/i18n/index.js'
import { Box, Text } from '../../ink.js'
import { extractMcpToolDisplayName, getMcpDisplayName } from '../../services/mcp/mcpStringUtils.js'
import type { Tool } from '../../Tool.js'
import { ConfigurableShortcutHint } from '../ConfigurableShortcutHint.js'
import { Dialog } from '../design-system/Dialog.js'
import type { ServerInfo } from './types.js'
type Props = {
  tool: Tool
  server: ServerInfo
  onBack: () => void
}
export function MCPToolDetailView({ tool, server, onBack }: Props) {
  const [toolDescription, setToolDescription] = React.useState('')
  let fullDisplayName
  const t1 = extractMcpToolDisplayName(fullDisplayName as any)
  const toolName = getMcpDisplayName(tool.name, server.name)
  fullDisplayName = tool.userFacingName ? tool.userFacingName({}) : toolName
  const displayName = t1
  const isReadOnly = tool.isReadOnly?.({}) ?? false
  const isDestructive = tool.isDestructive?.({}) ?? false
  const isOpenWorld = tool.isOpenWorld?.({}) ?? false
  React.useEffect(() => {
    const loadDescription = async function loadDescription() {
      try {
        const desc = await tool.description(
          {},
          {
            isNonInteractiveSession: false,
            toolPermissionContext: {
              mode: 'default' as const,
              additionalWorkingDirectories: new Map(),
              alwaysAllowRules: {},
              alwaysDenyRules: {},
              alwaysAskRules: {},
              isBypassPermissionsModeAvailable: false,
            },
            tools: [],
          },
        )
        setToolDescription(desc)
      } catch {
        setToolDescription(tSync('mcp.failedToLoadDescription'))
      }
    }
    loadDescription()
  }, [tool])
  const titleContent = (
    <>
      {displayName}
      {isReadOnly && <Text color="success"> [{tSync('mcp.readOnly')}]</Text>}
      {isDestructive && <Text color="error"> [{tSync('mcp.destructive')}]</Text>}
      {isOpenWorld && <Text dimColor={true}> [{tSync('mcp.openWorld')}]</Text>}
    </>
  )
  return (
    <Dialog
      title={titleContent}
      subtitle={server.name}
      onCancel={onBack}
      inputGuide={(exitState) =>
        exitState.pending ? (
          <Text>{tSync('permissionRules.pressAgainToExit', { keyName: exitState.keyName })}</Text>
        ) : (
          <ConfigurableShortcutHint
            action="confirm:no"
            context="Confirmation"
            fallback="Esc"
            description={tSync('mcp.goBack')}
          />
        )
      }
    >
      {
        <Box flexDirection="column">
          {
            <Box>
              {<Text bold={true}>{tSync('mcp.toolNameLabel')} </Text>}
              <Text dimColor={true}>{toolName}</Text>
            </Box>
          }
          {
            <Box>
              {<Text bold={true}>{tSync('mcp.fullNameLabel')} </Text>}
              <Text dimColor={true}>{tool.name}</Text>
            </Box>
          }
          {toolDescription && (
            <Box flexDirection="column" marginTop={1}>
              <Text bold={true}>{tSync('mcp.descriptionLabel')}</Text>
              <Text wrap="wrap">{toolDescription}</Text>
            </Box>
          )}
          {tool.inputJSONSchema &&
            tool.inputJSONSchema.properties &&
            Object.keys(tool.inputJSONSchema.properties).length > 0 && (
              <Box flexDirection="column" marginTop={1}>
                <Text bold={true}>{tSync('mcp.parametersLabel')}</Text>
                <Box marginLeft={2} flexDirection="column">
                  {Object.entries(tool.inputJSONSchema.properties).map((t17) => {
                    const [key, value] = t17
                    const required = tool.inputJSONSchema?.required as string[] | undefined
                    const isRequired = required?.includes(key)
                    return (
                      <Text key={key}>
                        • {key}
                        {isRequired && <Text dimColor={true}> ({tSync('mcp.required')})</Text>}:{' '}
                        <Text dimColor={true}>
                          {typeof value === 'object' && value && 'type' in value
                            ? String(value.type)
                            : 'unknown'}
                        </Text>
                        {typeof value === 'object' && value && 'description' in value && (
                          <Text dimColor={true}> - {String(value.description)}</Text>
                        )}
                      </Text>
                    )
                  })}
                </Box>
              </Box>
            )}
        </Box>
      }
    </Dialog>
  )
}
