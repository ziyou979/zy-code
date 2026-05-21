import { homedir } from 'node:os'
import React from 'react'
import { logEvent } from 'src/services/analytics/index.js'
import { setSessionTrustAccepted } from '../../bootstrap/state.js'
import type { Command } from '../../commands.js'
import { useExitOnCtrlCDWithKeybindings } from '../../hooks/useExitOnCtrlCDWithKeybindings.js'
import { tSync } from '../../i18n/index.js'
import { Box, Link, Text } from '../../ink.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import { getMcpConfigsByScope } from '../../services/mcp/config.js'
import { BASH_TOOL_NAME } from '../../tools/BashTool/toolName.js'
import { checkHasTrustDialogAccepted, saveCurrentProjectConfig } from '../../utils/config.js'
import { getCwd } from '../../utils/cwd.js'
import { getFsImplementation } from '../../utils/fsOperations.js'
import { gracefulShutdownSync } from '../../utils/gracefulShutdown.js'
import { Select } from '../CustomSelect/index.js'
import { PermissionDialog } from '../permissions/PermissionDialog.js'
import {
  getApiKeyHelperSources,
  getAwsCommandsSources,
  getBashPermissionSources,
  getDangerousEnvVarsSources,
  getGcpCommandsSources,
  getHooksSources,
  getOtelHeadersHelperSources,
} from './utils.js'

type Props = {
  onDone(): void
  commands?: Command[]
}
export function TrustDialog({ onDone, commands }: Props) {
  const { servers: projectServers } = getMcpConfigsByScope('project')
  const mcpServerKeys = Object.keys(projectServers)
  const hasMcpServers = mcpServerKeys.length > 0
  const hooksSettingSources = getHooksSources()
  const hasHooks = hooksSettingSources.length > 0
  const bashSettingSources = getBashPermissionSources()
  const apiKeyHelperSources = getApiKeyHelperSources()
  const hasApiKeyHelper = apiKeyHelperSources.length > 0
  const awsCommandsSources = getAwsCommandsSources()
  const hasAwsCommands = awsCommandsSources.length > 0
  const gcpCommandsSources = getGcpCommandsSources()
  const hasGcpCommands = gcpCommandsSources.length > 0
  const otelHeadersHelperSources = getOtelHeadersHelperSources()
  const hasOtelHeadersHelper = otelHeadersHelperSources.length > 0
  const dangerousEnvVarsSources = getDangerousEnvVarsSources()
  const hasDangerousEnvVars = dangerousEnvVarsSources.length > 0
  const hasSlashCommandBash =
    commands?.some(
      (command) =>
        command.type === 'prompt' &&
        command.loadedFrom === 'commands_DEPRECATED' &&
        (command.source === 'projectSettings' || command.source === 'localSettings') &&
        command.allowedTools?.some(
          (tool) => tool === BASH_TOOL_NAME || tool.startsWith(`${BASH_TOOL_NAME}(`),
        ),
    ) ?? false
  const hasSkillsBash =
    commands?.some(
      (command_0) =>
        command_0.type === 'prompt' &&
        (command_0.loadedFrom === 'skills' || command_0.loadedFrom === 'plugin') &&
        (command_0.source === 'projectSettings' ||
          command_0.source === 'localSettings' ||
          command_0.source === 'plugin') &&
        command_0.allowedTools?.some(
          (tool_0) => tool_0 === BASH_TOOL_NAME || tool_0.startsWith(`${BASH_TOOL_NAME}(`),
        ),
    ) ?? false
  const hasAnyBashExecution = bashSettingSources.length > 0 || hasSlashCommandBash || hasSkillsBash
  const hasTrustDialogAccepted = checkHasTrustDialogAccepted()
  React.useEffect(() => {
    const isHomeDir = homedir() === getCwd()
    logEvent('zy_trust_dialog_shown', {
      isHomeDir,
      hasMcpServers,
      hasHooks,
      hasBashExecution: hasAnyBashExecution,
      hasApiKeyHelper,
      hasAwsCommands,
      hasGcpCommands,
      hasOtelHeadersHelper,
      hasDangerousEnvVars,
    })
  }, [
    hasMcpServers,
    hasHooks,
    hasAnyBashExecution,
    hasApiKeyHelper,
    hasAwsCommands,
    hasGcpCommands,
    hasOtelHeadersHelper,
    hasDangerousEnvVars,
  ])
  const onChange = function onChange(value) {
    if (value === 'exit') {
      gracefulShutdownSync(1)
      return
    }
    const isHomeDir_0 = homedir() === getCwd()
    logEvent('zy_trust_dialog_accept', {
      isHomeDir: isHomeDir_0,
      hasMcpServers,
      hasHooks,
      hasBashExecution: hasAnyBashExecution,
      hasApiKeyHelper,
      hasAwsCommands,
      hasGcpCommands,
      hasOtelHeadersHelper,
      hasDangerousEnvVars,
    })
    if (isHomeDir_0) {
      setSessionTrustAccepted(true)
    } else {
      saveCurrentProjectConfig((current) => ({
        ...current,
        hasTrustDialogAccepted: true,
      }))
    }
    onDone()
  }
  const exitState = useExitOnCtrlCDWithKeybindings(() => gracefulShutdownSync(1))
  useKeybinding(
    'confirm:no',
    () => {
      gracefulShutdownSync(0)
    },
    {
      context: 'Confirmation',
    },
  )
  if (hasTrustDialogAccepted) {
    setTimeout(onDone)
    return null
  }
  return (
    <PermissionDialog color="warning" titleColor="warning" title={tSync('trustDialog.title')}>
      <Box flexDirection="column" gap={1} paddingTop={1}>
        {<Text bold={true}>{getFsImplementation().cwd()}</Text>}
        {<Text>{tSync('trustDialog.safetyCheck')}</Text>}
        {<Text>{tSync('trustDialog.capabilities')}</Text>}
        {
          <Text dimColor={true}>
            <Link url="https://code.zy.com/docs/en/security">
              {tSync('trustDialog.securityGuide')}
            </Link>
          </Text>
        }
        {
          <Select
            options={[
              {
                label: tSync('trustDialog.trust'),
                value: 'enable_all',
              },
              {
                label: tSync('trustDialog.exit'),
                value: 'exit',
              },
            ]}
            onChange={(value_0) => onChange(value_0 as 'enable_all' | 'exit')}
            onCancel={() => onChange('exit')}
          />
        }
        {
          <Text dimColor={true}>
            {exitState.pending
              ? tSync('trustDialog.pressAgainToExit', { key: exitState.keyName })
              : tSync('trustDialog.enterToConfirm')}
          </Text>
        }
      </Box>
    </PermissionDialog>
  )
}
