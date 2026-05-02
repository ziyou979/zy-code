import figures from 'figures'
import * as React from 'react'
import { useState } from 'react'
import { tSync } from 'src/i18n/index.js'
import TextInput from '../../../components/TextInput.js'
import { useExitOnCtrlCDWithKeybindings } from '../../../hooks/useExitOnCtrlCDWithKeybindings.js'
import { useTerminalSize } from '../../../hooks/useTerminalSize.js'
import { Box, Newline, Text } from '../../../ink.js'
import { useKeybinding } from '../../../keybindings/useKeybinding.js'
import { BashTool } from '../../../tools/BashTool/BashTool.js'
import { WebFetchTool } from '../../../tools/WebFetchTool/WebFetchTool.js'
import type {
  PermissionBehavior,
  PermissionRuleValue,
} from '../../../utils/permissions/PermissionRule.js'
import {
  permissionRuleValueFromString,
  permissionRuleValueToString,
} from '../../../utils/permissions/permissionRuleParser.js'
export type PermissionRuleInputProps = {
  onCancel: () => void
  onSubmit: (ruleValue: PermissionRuleValue, ruleBehavior: PermissionBehavior) => void
  ruleBehavior: PermissionBehavior
}
export function PermissionRuleInput({
  onCancel,
  onSubmit,
  ruleBehavior,
}: PermissionRuleInputProps) {
  const [inputValue, setInputValue] = useState('')
  const [cursorOffset, setCursorOffset] = useState(0)
  const exitState = useExitOnCtrlCDWithKeybindings()
  useKeybinding('confirm:no', onCancel, {
    context: 'Settings',
  })
  const { columns } = useTerminalSize()
  const textInputColumns = columns - 6
  const handleSubmit = (value) => {
    const trimmedValue = value.trim()
    if (trimmedValue.length === 0) {
      return
    }
    const ruleValue = permissionRuleValueFromString(trimmedValue)
    onSubmit(ruleValue, ruleBehavior)
  }
  return (
    <>
      {
        <Box
          flexDirection="column"
          gap={1}
          borderStyle="round"
          paddingLeft={1}
          paddingRight={1}
          borderColor="permission"
        >
          {
            <Text bold={true} color="permission">
              {tSync('permissionRules.addPermissionRuleHeader', { behavior: ruleBehavior })}
            </Text>
          }
          {
            <Box flexDirection="column">
              {
                <Text>
                  {tSync('permissionRules.permissionRulesDescription')}
                  {<Newline />}e.g.,{' '}
                  {
                    <Text bold={true}>
                      {permissionRuleValueToString({
                        toolName: WebFetchTool.name,
                      })}
                    </Text>
                  }
                  {<Text bold={false}> or </Text>}
                  <Text bold={true}>
                    {permissionRuleValueToString({
                      toolName: BashTool.name,
                      ruleContent: 'ls:*',
                    })}
                  </Text>
                </Text>
              }
              <Box borderDimColor={true} borderStyle="round" marginY={1} paddingLeft={1}>
                <TextInput
                  showCursor={true}
                  value={inputValue}
                  onChange={setInputValue}
                  onSubmit={handleSubmit}
                  placeholder={tSync('permissionRules.enterPermissionRulePlaceholder')}
                  columns={textInputColumns}
                  cursorOffset={cursorOffset}
                  onChangeCursorOffset={setCursorOffset}
                />
              </Box>
            </Box>
          }
        </Box>
      }
      {
        <Box marginLeft={3}>
          {exitState.pending ? (
            <Text dimColor={true}>
              {tSync('permissionRules.pressAgainToExit', { keyName: exitState.keyName })}
            </Text>
          ) : (
            <Text dimColor={true}>{tSync('permissionRules.enterSubmitEscCancel')}</Text>
          )}
        </Box>
      }
    </>
  )
}
