import React from 'react'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { Box, Text, useTheme } from '../../ink.js'
import { sanitizeToolNameForAnalytics } from '../../services/analytics/metadata.js'
import { env } from '../../utils/env.js'
import { shouldShowAlwaysAllowOptions } from '../../utils/permissions/permissionsLoader.js'
import { truncateToLines } from '../../utils/stringUtils.js'
import { logUnaryEvent } from '../../utils/unaryLogging.js'
import { usePermissionRequestLogging } from './hooks.js'
import { PermissionDialog } from './PermissionDialog.js'
import { PermissionPrompt } from './PermissionPrompt.js'
import { PermissionRuleExplanation } from './PermissionRuleExplanation.js'
import { tSync } from 'src/i18n/index.js'
type FallbackOptionValue = 'yes' | 'yes-dont-ask-again' | 'no'
export function FallbackPermissionRequest({ toolUseConfirm, onDone, onReject, workerBadge }) {
  const [theme] = useTheme()
  const originalUserFacingName = toolUseConfirm.tool.userFacingName(toolUseConfirm.input as never)
  const userFacingName = originalUserFacingName.endsWith(' (MCP)')
    ? originalUserFacingName.slice(0, -6)
    : originalUserFacingName
  const unaryEvent = {
    completion_type: 'tool_use_single',
    language_name: 'none',
  }
  usePermissionRequestLogging(toolUseConfirm, unaryEvent as any)
  const handleSelect = (value, feedback) => {
    switch (value) {
      case 'yes': {
        logUnaryEvent({
          completion_type: 'tool_use_single',
          event: 'accept',
          metadata: {
            language_name: 'none',
            message_id: toolUseConfirm.assistantMessage.message.id,
            platform: env.platform,
          },
        })
        toolUseConfirm.onAllow(toolUseConfirm.input, [], feedback)
        onDone()
        break
      }
      case 'yes-dont-ask-again': {
        logUnaryEvent({
          completion_type: 'tool_use_single',
          event: 'accept',
          metadata: {
            language_name: 'none',
            message_id: toolUseConfirm.assistantMessage.message.id,
            platform: env.platform,
          },
        })
        toolUseConfirm.onAllow(toolUseConfirm.input, [
          {
            type: 'addRules',
            rules: [
              {
                toolName: toolUseConfirm.tool.name,
              },
            ],
            behavior: 'allow',
            destination: 'localSettings',
          },
        ])
        onDone()
        break
      }
      case 'no': {
        logUnaryEvent({
          completion_type: 'tool_use_single',
          event: 'reject',
          metadata: {
            language_name: 'none',
            message_id: toolUseConfirm.assistantMessage.message.id,
            platform: env.platform,
          },
        })
        toolUseConfirm.onReject(feedback)
        onReject()
        onDone()
      }
    }
  }
  const handleCancel = () => {
    logUnaryEvent({
      completion_type: 'tool_use_single',
      event: 'reject',
      metadata: {
        language_name: 'none',
        message_id: toolUseConfirm.assistantMessage.message.id,
        platform: env.platform,
      },
    })
    toolUseConfirm.onReject()
    onReject()
    onDone()
  }
  const originalCwd = getOriginalCwd()
  const showAlwaysAllowOptions = shouldShowAlwaysAllowOptions()
  const result = [
    {
      label: tSync('permission.yes'),
      value: 'yes',
      feedbackConfig: {
        type: 'accept',
      },
    },
  ]
  if (showAlwaysAllowOptions) {
    result.push({
      label: (
        <Text>
          {tSync('permission.yesDontAskAgainCommands', { name: userFacingName, cwd: originalCwd })}
        </Text>
      ) as any,
      value: 'yes-dont-ask-again',
      feedbackConfig: {
        type: 'accept',
      },
    })
  }
  const rejectOption = {
    label: tSync('permission.no'),
    value: 'no',
    feedbackConfig: {
      type: 'reject',
    },
  }
  result.push(rejectOption)
  const options = result
  const sanitizedToolName = sanitizeToolNameForAnalytics(toolUseConfirm.tool.name)
  const toolAnalyticsContext = {
    toolName: sanitizedToolName,
    isMcp: toolUseConfirm.tool.isMcp ?? false,
  }
  const t11 = toolUseConfirm.tool.renderToolUseMessage(toolUseConfirm.input as never, {
    theme,
    verbose: true,
  })
  const t12 = originalUserFacingName.endsWith(' (MCP)') ? <Text dimColor={true}> (MCP)</Text> : ''
  const t14 = truncateToLines(toolUseConfirm.description, 3)
  // @ts-ignore
  return (
    <PermissionDialog title={tSync('permissionRules.toolUse')} workerBadge={workerBadge}>
      {
        <Box flexDirection="column" paddingX={2} paddingY={1}>
          {
            <Text>
              {userFacingName}({t11}){t12}
            </Text>
          }
          {<Text dimColor={true}>{t14}</Text>}
        </Box>
      }
      {
        <Box flexDirection="column">
          {
            <PermissionRuleExplanation
              permissionResult={toolUseConfirm.permissionResult}
              toolType="tool"
            />
          }
          {
            <PermissionPrompt
              options={options}
              onSelect={handleSelect}
              onCancel={handleCancel}
              toolAnalyticsContext={toolAnalyticsContext}
            />
          }
        </Box>
      }
    </PermissionDialog>
  )
}
