import { tSync } from 'src/i18n/index.js'
import { Box, Text, useTheme } from '../../../ink/index.js'
import { WebFetchTool } from '../../../tools/WebFetchTool/WebFetchTool.js'
import { shouldShowAlwaysAllowOptions } from '../../../services/permissions/permissionsLoader.js'
import { Select } from '../../CustomSelect/select.js'
import { usePermissionRequestLogging } from '../hooks.js'
import { PermissionDialog } from '../PermissionDialog.js'
import { PermissionRuleExplanation } from '../PermissionRuleExplanation.js'
import { logUnaryPermissionEvent } from '../utils.js'

function inputToPermissionRuleContent(input: { [k: string]: unknown }): string {
  try {
    const parsedInput = WebFetchTool.inputSchema.safeParse(input)
    if (!parsedInput.success) {
      return `input:${input.toString()}`
    }
    const { url } = parsedInput.data
    const hostname = new URL(url).hostname
    return `domain:${hostname}`
  } catch {
    return `input:${input.toString()}`
  }
}
export function WebFetchPermissionRequest({
  toolUseConfirm,
  onDone,
  onReject,
  verbose,
  workerBadge,
}: import('../PermissionRequest.js').PermissionRequestProps) {
  const [theme] = useTheme()
  const { url } = toolUseConfirm.input as {
    url: string
  }
  const parsedUrl = new URL(url)
  const hostname = parsedUrl.hostname
  const unaryEvent: import('../hooks.js').UnaryEvent = {
    completion_type: 'tool_use_single',
    language_name: 'none',
  }
  usePermissionRequestLogging(toolUseConfirm, unaryEvent)
  const showAlwaysAllowOptions = shouldShowAlwaysAllowOptions()
  const result: {
    label: React.ReactNode
    value: string
  }[] = [
    {
      label: tSync('permission.yes'),
      value: 'yes',
    },
  ]
  if (showAlwaysAllowOptions) {
    result.push({
      label: <Text>{tSync('permission.yesDontAskAgainDomain', { domain: hostname })}</Text>,
      value: 'yes-dont-ask-again-domain',
    })
  }
  result.push({
    label: tSync('permission.noAndTell'),
    value: 'no',
  })
  const options = result
  const onChange = function onChange(newValue: string) {
    switch (newValue) {
      case 'yes': {
        logUnaryPermissionEvent('tool_use_single', toolUseConfirm, 'accept')
        toolUseConfirm.onAllow(toolUseConfirm.input, [])
        onDone()
        break
      }
      case 'yes-dont-ask-again-domain': {
        logUnaryPermissionEvent('tool_use_single', toolUseConfirm, 'accept')
        const ruleContent = inputToPermissionRuleContent(toolUseConfirm.input)
        const ruleValue = {
          toolName: toolUseConfirm.tool.name,
          ruleContent,
        }
        toolUseConfirm.onAllow(toolUseConfirm.input, [
          {
            type: 'addRules',
            rules: [ruleValue],
            behavior: 'allow',
            destination: 'localSettings',
          },
        ])
        onDone()
        break
      }
      case 'no': {
        logUnaryPermissionEvent('tool_use_single', toolUseConfirm, 'reject')
        toolUseConfirm.onReject()
        onReject()
        onDone()
      }
    }
  }
  const renderedWebFetchMessage = WebFetchTool.renderToolUseMessage(
    toolUseConfirm.input as {
      url: string
      prompt: string
    },
    {
      theme,
      verbose,
    },
  )
  return (
    <PermissionDialog title={tSync('permission.fetch')} workerBadge={workerBadge}>
      {
        <Box flexDirection="column" paddingX={2} paddingY={1}>
          {<Text>{renderedWebFetchMessage}</Text>}
          {<Text dimColor={true}>{toolUseConfirm.description}</Text>}
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
          {<Text>{tSync('permission.allowWebFetch')}</Text>}
          {<Select options={options} onChange={onChange} onCancel={() => onChange('no')} />}
        </Box>
      }
    </PermissionDialog>
  )
}
