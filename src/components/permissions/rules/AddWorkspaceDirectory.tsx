import figures from 'figures'
import * as React from 'react'
import { useEffect, useState } from 'react'
import { useDebounceCallback } from 'usehooks-ts'
import { tSync } from 'src/i18n/index.js'
import {
  addDirHelpMessage,
  validateDirectoryForWorkspace,
} from '../../../commands/add-dir/validation.js'
import TextInput from '../../../components/TextInput.js'
import { Box, Text } from '../../../ink.js'
import { useKeybinding } from '../../../keybindings/useKeybinding.js'
import type { ToolPermissionContext } from '../../../Tool.js'
import { getDirectoryCompletions } from '../../../utils/suggestions/directoryCompletion.js'
import { ConfigurableShortcutHint } from '../../ConfigurableShortcutHint.js'
import { Select } from '../../CustomSelect/select.js'
import { Byline } from '../../design-system/Byline.js'
import { Dialog } from '../../design-system/Dialog.js'
import { KeyboardShortcutHint } from '../../design-system/KeyboardShortcutHint.js'
import { PromptInputFooterSuggestions } from '../../PromptInput/PromptInputFooterSuggestions.js'
type Props = {
  onAddDirectory: (path: string, remember?: boolean) => void
  onCancel: () => void
  permissionContext: ToolPermissionContext
  directoryPath?: string // When directoryPath is provided, show selection options instead of input
}
type RememberDirectoryOption = 'yes-session' | 'yes-remember' | 'no'
const REMEMBER_DIRECTORY_OPTIONS: Array<{
  value: RememberDirectoryOption
  label: string
}> = [
  {
    value: 'yes-session',
    label: tSync('permissionRules.yesForThisSession'),
  },
  {
    value: 'yes-remember',
    label: tSync('permissionRules.yesAndRememberDirectory'),
  },
  {
    value: 'no',
    label: tSync('permission.no'),
  },
]
function PermissionDescription() {
  return <Text dimColor={true}>{tSync('permissionRules.workspacePermissionDescription')}</Text>
}
function DirectoryDisplay({ path }) {
  return (
    <Box flexDirection="column" paddingX={2} gap={1}>
      {<Text color="permission">{path}</Text>}
      {<PermissionDescription />}
    </Box>
  )
}
function DirectoryInput({ value, onChange, onSubmit, error, suggestions, selectedSuggestion }) {
  return (
    <Box flexDirection="column">
      {<Text>{tSync('permissionRules.enterDirectoryPath')}</Text>}
      {
        <Box borderDimColor={true} borderStyle="round" marginY={1} paddingLeft={1}>
          <TextInput
            showCursor={true}
            placeholder={tSync('permissionRules.directoryPathPlaceholder')}
            value={value}
            onChange={onChange}
            onSubmit={onSubmit}
            columns={80}
            cursorOffset={value.length}
            onChangeCursorOffset={_temp}
          />
        </Box>
      }
      {suggestions.length > 0 && (
        <Box marginBottom={1}>
          <PromptInputFooterSuggestions
            suggestions={suggestions}
            selectedSuggestion={selectedSuggestion}
          />
        </Box>
      )}
      {error && <Text color="error">{error}</Text>}
    </Box>
  )
}
function _temp() {}
export function AddWorkspaceDirectory({
  onAddDirectory,
  onCancel,
  permissionContext,
  directoryPath,
}: Props) {
  const [directoryInput, setDirectoryInput] = useState('')
  const [error, setError] = useState(null)
  const [suggestions, setSuggestions] = useState([])
  const [selectedSuggestion, setSelectedSuggestion] = useState(0)
  const fetchSuggestions = async (path) => {
    if (!path) {
      setSuggestions([])
      setSelectedSuggestion(0)
      return
    }
    const completions = await getDirectoryCompletions(path)
    setSuggestions(completions)
    setSelectedSuggestion(0)
  }
  const debouncedFetchSuggestions = useDebounceCallback(fetchSuggestions, 100)
  useEffect(() => {
    debouncedFetchSuggestions(directoryInput)
  }, [directoryInput, debouncedFetchSuggestions])
  const applySuggestion = (suggestion) => {
    const newPath = suggestion.id + '/'
    setDirectoryInput(newPath)
    setError(null)
  }
  const handleSubmit = async (newPath_0) => {
    const result = await validateDirectoryForWorkspace(newPath_0, permissionContext)
    if (result.resultType === 'success') {
      onAddDirectory(result.absolutePath, false)
    } else {
      setError(addDirHelpMessage(result))
    }
  }
  useKeybinding('confirm:no', onCancel, {
    context: 'Settings',
  })
  const handleKeyDown = (e) => {
    if (suggestions.length > 0) {
      if (e.key === 'tab') {
        e.preventDefault()
        const suggestion_0 = suggestions[selectedSuggestion]
        if (suggestion_0) {
          applySuggestion(suggestion_0)
        }
        return
      }
      if (e.key === 'return') {
        e.preventDefault()
        const suggestion_1 = suggestions[selectedSuggestion]
        if (suggestion_1) {
          handleSubmit(suggestion_1.id + '/')
        }
        return
      }
      if (e.key === 'up' || (e.ctrl && e.key === 'p')) {
        e.preventDefault()
        setSelectedSuggestion((prev) => (prev <= 0 ? suggestions.length - 1 : prev - 1))
        return
      }
      if (e.key === 'down' || (e.ctrl && e.key === 'n')) {
        e.preventDefault()
        setSelectedSuggestion((prev_0) => (prev_0 >= suggestions.length - 1 ? 0 : prev_0 + 1))
        return
      }
    }
  }
  const handleSelect = (value) => {
    if (!directoryPath) {
      return
    }
    const selectionValue = value as RememberDirectoryOption
    switch (selectionValue) {
      case 'yes-session': {
        onAddDirectory(directoryPath, false)
        break
      }
      case 'yes-remember': {
        onAddDirectory(directoryPath, true)
        break
      }
      case 'no': {
        onCancel()
      }
    }
  }
  return (
    <Box flexDirection="column" tabIndex={0} autoFocus={true} onKeyDown={handleKeyDown}>
      {
        <Dialog
          title={tSync('permissionRules.addDirectoryToWorkspace')}
          onCancel={onCancel}
          color="permission"
          isCancelActive={false}
          inputGuide={
            directoryPath
              ? undefined
              : (exitState) =>
                  exitState.pending ? (
                    <Text>
                      {tSync('permissionRules.pressAgainToExit', { keyName: exitState.keyName })}
                    </Text>
                  ) : (
                    <Byline>
                      <KeyboardShortcutHint shortcut="Tab" action="complete" />
                      <KeyboardShortcutHint shortcut="Enter" action="add" />
                      <ConfigurableShortcutHint
                        action="confirm:no"
                        context="Settings"
                        fallback="Esc"
                        description={tSync('permissionRules.cancel')}
                      />
                    </Byline>
                  )
          }
        >
          {directoryPath ? (
            <Box flexDirection="column" gap={1}>
              <DirectoryDisplay path={directoryPath} />
              <Select
                options={REMEMBER_DIRECTORY_OPTIONS}
                onChange={handleSelect}
                onCancel={() => handleSelect('no')}
              />
            </Box>
          ) : (
            <Box flexDirection="column" gap={1} marginX={2}>
              <PermissionDescription />
              <DirectoryInput
                value={directoryInput}
                onChange={setDirectoryInput}
                onSubmit={handleSubmit}
                error={error}
                suggestions={suggestions}
                selectedSuggestion={selectedSuggestion}
              />
            </Box>
          )}
        </Dialog>
      }
    </Box>
  )
}
