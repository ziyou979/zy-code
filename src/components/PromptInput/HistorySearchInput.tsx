import { stringWidth } from '../../ink/stringWidth.js'
import { Box, Text } from '../../ink/index.js'
import TextInput from '../TextInput.js'

type Props = {
  value: string
  onChange: (value: string) => void
  historyFailedMatch: boolean
}
function HistorySearchInput({ value, onChange, historyFailedMatch }: Props) {
  const inputWidth = stringWidth(value) + 1
  return (
    <Box gap={1}>
      {
        <Text dimColor={true}>
          {historyFailedMatch ? 'no matching prompt:' : 'search prompts:'}
        </Text>
      }
      {
        <TextInput
          value={value}
          onChange={onChange}
          cursorOffset={value.length}
          onChangeCursorOffset={noopCursorHandler}
          columns={inputWidth}
          focus={true}
          showCursor={true}
          multiline={false}
          dimColor={true}
        />
      }
    </Box>
  )
}
function noopCursorHandler() {}
export default HistorySearchInput
