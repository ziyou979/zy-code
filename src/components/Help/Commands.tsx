import { type Command, formatDescriptionWithSource } from '../../commands/index.js'
import { Box, Text } from '../../ink/index.js'
import { truncate } from '../../utils/format.js'
import { Select } from '../CustomSelect/select.js'
import { useTabHeaderFocus } from '../design-system/Tabs.js'

type Props = {
  commands: Command[]
  maxHeight: number
  columns: number
  title: string
  onCancel: () => void
  emptyMessage?: string
}
export function Commands({ commands, maxHeight, columns, title, onCancel, emptyMessage }: Props) {
  const { headerFocused, focusHeader } = useTabHeaderFocus()
  const maxWidth = Math.max(1, columns - 10)
  const visibleCount = Math.max(1, Math.floor((maxHeight - 10) / 2))
  const seen = new Set()
  const options = commands
    .filter((cmd) => {
      if (seen.has(cmd.name)) {
        return false
      }
      seen.add(cmd.name)
      return true
    })
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((cmd_0) => ({
      label: `/${cmd_0.name}`,
      value: cmd_0.name,
      description: truncate(formatDescriptionWithSource(cmd_0), maxWidth, true),
    }))
  return (
    <Box flexDirection="column" paddingY={1}>
      {commands.length === 0 && emptyMessage ? (
        <Text dimColor={true}>{emptyMessage}</Text>
      ) : (
        <>
          <Text>{title}</Text>
          <Box marginTop={1}>
            <Select
              options={options}
              visibleOptionCount={visibleCount}
              onCancel={onCancel}
              disableSelection={true}
              hideIndexes={true}
              layout="compact-vertical"
              onUpFromFirstItem={focusHeader}
              isDisabled={headerFocused}
            />
          </Box>
        </>
      )}
    </Box>
  )
}
