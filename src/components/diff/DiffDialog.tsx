import type { StructuredPatchHunk } from 'diff'
import { useEffect, useRef, useState } from 'react'
import type { CommandResultDisplay } from '../../commands.js'
import { PLAY_ICON, REVERSE_PLAY_ICON } from '../../constants/figures.js'
import { useRegisterOverlay } from '../../context/OverlayContext.js'
import { type DiffData, useDiffData } from '../../hooks/useDiffData.js'
import { type TurnDiff, useTurnDiffs } from '../../hooks/useTurnDiffs.js'
import { tSync } from '../../i18n/index.js'
import { Box, Text } from '../../ink.js'
import { useKeybindings } from '../../keybindings/useKeybinding.js'
import { useShortcutDisplay } from '../../keybindings/useShortcutDisplay.js'
import type { Message } from '../../types/message.js'
import { plural } from '../../utils/stringUtils.js'
import { Byline } from '../design-system/Byline.js'
import { Dialog } from '../design-system/Dialog.js'
import { DiffDetailView } from './DiffDetailView.js'
import { DiffFileList } from './DiffFileList.js'

type Props = {
  messages: Message[]
  onDone: (
    result?: string,
    options?: {
      display?: CommandResultDisplay
    },
  ) => void
}
type ViewMode = 'list' | 'detail'
type DiffSource =
  | {
      type: 'current'
    }
  | {
      type: 'turn'
      turn: TurnDiff
    }
function turnDiffToDiffData(turn: TurnDiff): DiffData {
  const files = Array.from(turn.files.values())
    .map((f) => ({
      path: f.filePath,
      linesAdded: f.linesAdded,
      linesRemoved: f.linesRemoved,
      isBinary: false,
      isLargeFile: false,
      isTruncated: false,
      isNewFile: f.isNewFile,
    }))
    .sort((a, b) => a.path.localeCompare(b.path))
  const hunks = new Map<string, StructuredPatchHunk[]>()
  for (const f of turn.files.values()) {
    hunks.set(f.filePath, f.hunks)
  }
  return {
    stats: {
      filesCount: turn.stats.filesChanged,
      linesAdded: turn.stats.linesAdded,
      linesRemoved: turn.stats.linesRemoved,
    },
    files,
    hunks,
    loading: false,
  }
}
export function DiffDialog({ messages, onDone }: Props) {
  const gitDiffData = useDiffData()
  const turnDiffs = useTurnDiffs(messages)
  const [viewMode, setViewMode] = useState('list')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [sourceIndex, setSourceIndex] = useState(0)
  const sources = [
    {
      type: 'current',
    },
    ...turnDiffs.map((turn) => ({
      type: 'turn',
      turn,
    })),
  ]
  const currentSource = sources[sourceIndex]
  // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
  const currentTurn = currentSource?.type === 'turn' ? (currentSource as any).turn : null
  const diffData = currentTurn ? turnDiffToDiffData(currentTurn) : gitDiffData
  const selectedFile = diffData.files[selectedIndex]
  const selectedHunks = selectedFile ? diffData.hunks.get(selectedFile.path) || [] : []
  useEffect(() => {
    if (sourceIndex >= sources.length) {
      setSourceIndex(Math.max(0, sources.length - 1))
    }
  }, [sources.length, sourceIndex])
  const prevSourceIndex = useRef(sourceIndex)
  useEffect(() => {
    if (prevSourceIndex.current !== sourceIndex) {
      setSelectedIndex(0)
      prevSourceIndex.current = sourceIndex
    }
  }, [sourceIndex])
  useRegisterOverlay('diff-dialog')
  useKeybindings(
    {
      'diff:previousSource': () => {
        if (viewMode === 'detail') {
          setViewMode('list')
        } else {
          if (viewMode === 'list' && sources.length > 1) {
            setSourceIndex((prev) => Math.max(0, prev - 1))
          }
        }
      },
      'diff:nextSource': () => {
        if (viewMode === 'list' && sources.length > 1) {
          setSourceIndex((prev_0) => Math.min(sources.length - 1, prev_0 + 1))
        }
      },
      'diff:back': () => {
        if (viewMode === 'detail') {
          setViewMode('list')
        }
      },
      'diff:viewDetails': () => {
        if (viewMode === 'list' && selectedFile) {
          setViewMode('detail')
        }
      },
      'diff:previousFile': () => {
        if (viewMode === 'list') {
          setSelectedIndex((prev_1) => Math.max(0, prev_1 - 1))
        }
      },
      'diff:nextFile': () => {
        if (viewMode === 'list') {
          setSelectedIndex((prev_2) => Math.min(diffData.files.length - 1, prev_2 + 1))
        }
      },
    },
    {
      context: 'DiffDialog',
    },
  )
  const subtitle = diffData.stats ? (
    <Text dimColor={true}>
      {diffData.stats.filesCount}{' '}
      {plural(diffData.stats.filesCount, tSync('diffDialog.file'), tSync('diffDialog.files'))}{' '}
      {tSync('diffDialog.changed')}
      {diffData.stats.linesAdded > 0 && (
        <Text color="diffAddedWord"> +{diffData.stats.linesAdded}</Text>
      )}
      {diffData.stats.linesRemoved > 0 && (
        <Text color="diffRemovedWord"> -{diffData.stats.linesRemoved}</Text>
      )}
    </Text>
  ) : null
  const headerTitle = currentTurn
    ? `${tSync('diffDialog.turn')} ${currentTurn.turnIndex}`
    : tSync('diffDialog.uncommittedChanges')
  const headerSubtitle = currentTurn
    ? currentTurn.userPromptPreview
      ? `"${currentTurn.userPromptPreview}"`
      : ''
    : tSync('diffDialog.gitDiffHead')
  const sourceSelector =
    sources.length > 1 ? (
      <Box>
        {sourceIndex > 0 && <Text dimColor={true}>{REVERSE_PLAY_ICON} </Text>}
        {sources.map((source, i) => {
          const isSelected = i === sourceIndex
          const label =
            source.type === 'current'
              ? tSync('diffDialog.current')
              : // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
                `T${(source as any).turn.turnIndex}`
          return (
            <Text key={i} dimColor={!isSelected} bold={isSelected}>
              {i > 0 ? ' \xB7 ' : ''}
              {label}
            </Text>
          )
        })}
        {sourceIndex < sources.length - 1 && <Text dimColor={true}> {PLAY_ICON}</Text>}
      </Box>
    ) : null
  const dismissShortcut = useShortcutDisplay('diff:dismiss', 'DiffDialog', 'esc')
  let emptyMessage
  if (diffData.loading) {
    emptyMessage = tSync('diffDialog.loadingDiff')
  } else if (currentTurn) {
    emptyMessage = tSync('diffDialog.noFileChangesInTurn')
  } else if (diffData.stats && diffData.stats.filesCount > 0 && diffData.files.length === 0) {
    emptyMessage = tSync('diffDialog.tooManyFilesToDisplay')
  } else {
    emptyMessage = tSync('diffDialog.workingTreeIsClean')
  }
  const title = (
    <Text>
      {headerTitle}
      {headerSubtitle && <Text dimColor={true}> {headerSubtitle}</Text>}
    </Text>
  )
  const handleCancel = function handleCancel() {
    if (viewMode === 'detail') {
      setViewMode('list')
    } else {
      onDone('Diff dialog dismissed', {
        display: 'system',
      })
    }
  }
  return (
    <Dialog
      title={title}
      onCancel={handleCancel}
      color="background"
      inputGuide={(exitState) =>
        exitState.pending ? (
          <Text>{tSync('diffDialog.pressAgainToExit', { keyName: exitState.keyName ?? '' })}</Text>
        ) : viewMode === 'list' ? (
          <Byline>
            {sources.length > 1 && <Text>{tSync('diffDialog.sourceNav')}</Text>}
            <Text>{tSync('diffDialog.select')}</Text>
            <Text>{tSync('diffDialog.enterView')}</Text>
            <Text>
              {dismissShortcut} {tSync('diffDialog.close')}
            </Text>
          </Byline>
        ) : (
          <Byline>
            <Text>{tSync('diffDialog.back')}</Text>
            <Text>
              {dismissShortcut} {tSync('diffDialog.close')}
            </Text>
          </Byline>
        )
      }
    >
      {sourceSelector}
      {subtitle}
      {diffData.files.length === 0 ? (
        <Box marginTop={1}>
          <Text dimColor={true}>{emptyMessage}</Text>
        </Box>
      ) : viewMode === 'list' ? (
        <Box flexDirection="column" marginTop={1}>
          <DiffFileList files={diffData.files} selectedIndex={selectedIndex} />
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          <DiffDetailView
            filePath={selectedFile?.path || ''}
            hunks={selectedHunks}
            isLargeFile={selectedFile?.isLargeFile}
            isBinary={selectedFile?.isBinary}
            isTruncated={selectedFile?.isTruncated}
            isUntracked={selectedFile?.isUntracked}
          />
        </Box>
      )}
    </Dialog>
  )
}
