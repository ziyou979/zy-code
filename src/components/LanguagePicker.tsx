import { POINTER, ELLIPSIS } from '../constants/figures.js'
import { useState } from 'react'
import { tSync } from 'src/i18n/index.js'
import { Box, Text } from '../ink.js'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import TextInput from './TextInput.js'

type Props = {
  initialLanguage: string | undefined
  onComplete: (language: string | undefined) => void
  onCancel: () => void
}
export function LanguagePicker({ initialLanguage, onComplete, onCancel }: Props) {
  const [language, setLanguage] = useState(initialLanguage)
  const [cursorOffset, setCursorOffset] = useState((initialLanguage ?? '').length)
  useKeybinding('confirm:no', onCancel, {
    context: 'Settings',
  })
  const handleSubmit = function handleSubmit() {
    const trimmed = language?.trim()
    onComplete(trimmed || undefined)
  }
  return (
    <Box flexDirection="column" gap={1}>
      {<Text>{tSync('languagePicker.enterLanguage')}</Text>}
      {
        <Box flexDirection="row" gap={1}>
          {<Text>{POINTER}</Text>}
          <TextInput
            value={language ?? ''}
            onChange={setLanguage}
            onSubmit={handleSubmit}
            focus={true}
            showCursor={true}
            placeholder={tSync('languagePicker.placeholder', { ellipsis: ELLIPSIS })}
            columns={60}
            cursorOffset={cursorOffset}
            onChangeCursorOffset={setCursorOffset}
          />
        </Box>
      }
      {<Text dimColor={true}>{tSync('languagePicker.defaultHint')}</Text>}
    </Box>
  )
}
