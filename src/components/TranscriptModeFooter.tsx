import { ARROW_DOWN, ARROW_UP } from '../constants/figures.js'
import { tSync } from '../i18n/index.js'
import { Box, Text } from '../ink/index.js'
import { useShortcutDisplay } from '../keybindings/useShortcutDisplay.js'

/**
 * Small component to display transcript mode footer with dynamic keybinding.
 * Must be rendered inside KeybindingSetup to access keybinding context.
 */
export function TranscriptModeFooter({
  showAllInTranscript,
  virtualScroll,
  searchBadge,
  suppressShowAll = false,
  status,
}: {
  showAllInTranscript: boolean
  virtualScroll: boolean
  searchBadge: { current: number; count: number } | null
  suppressShowAll?: boolean
  status: string
}) {
  const toggleShortcut = useShortcutDisplay('app:toggleTranscript', 'Global', 'ctrl+o')
  const showAllShortcut = useShortcutDisplay('transcript:toggleShowAll', 'Transcript', 'ctrl+e')
  const transcriptLabel = tSync('transcript.showingDetailedTranscript')
  const toggleLabel = tSync('transcript.toToggle')
  const navigateLabel = tSync('transcript.toNavigate')
  const scrollLabel = tSync('transcript.scroll')
  const topLabel = tSync('transcript.top')
  const bottomLabel = tSync('transcript.bottom')
  const collapseOrShowLabel = showAllInTranscript
    ? tSync('transcript.toCollapse')
    : tSync('transcript.toShowAll')
  return (
    <Box
      noSelect={true}
      alignItems="center"
      alignSelf="center"
      borderTopDimColor={true}
      borderBottom={false}
      borderLeft={false}
      borderRight={false}
      borderStyle="single"
      marginTop={1}
      paddingLeft={2}
      width="100%"
    >
      {
        <Text dimColor={true}>
          {transcriptLabel}
          {' \xB7 '}
          {toggleShortcut} {toggleLabel}
          {searchBadge
            ? ` \xB7 n/N ${navigateLabel}`
            : virtualScroll
              ? ` \xB7 ${ARROW_UP}${ARROW_DOWN} ${scrollLabel} \xB7 home/end ${topLabel}/${bottomLabel}`
              : suppressShowAll
                ? ''
                : ` \xB7 ${showAllShortcut} ${collapseOrShowLabel}`}
        </Text>
      }
      {status ? (
        <>
          <Box flexGrow={1} />
          <Text>{status} </Text>
        </>
      ) : searchBadge ? (
        <>
          <Box flexGrow={1} />
          <Text dimColor={true}>
            {searchBadge.current}/{searchBadge.count}
            {'  '}
          </Text>
        </>
      ) : null}
    </Box>
  )
}
