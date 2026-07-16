import * as path from 'node:path'
import { useEffect, useRef, useState } from 'react'
import { useRegisterOverlay } from '../context/OverlayContext.js'
import { generateFileSuggestions } from '../hooks/fileSuggestions.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { tSync } from '../i18n/index.js'
import { Text } from '../ink/index.js'
import { logEvent } from '../services/analytics/index.js'
import { getCwd } from '../utils/cwd.js'
import { openFileInExternalEditor } from '../terminal-ui/editor.js'
import { truncatePathMiddle, truncateToWidth } from '../utils/format.js'
import { highlightMatch } from '../components/Runtime/HighlightMatch.js'
import { readFileInRange } from '../utils/readFileInRange.js'
import { FuzzyPicker } from './design-system/FuzzyPicker.js'
import { LoadingState } from './design-system/LoadingState.js'

type Props = {
  onDone: () => void
  onInsert: (text: string) => void
}
const VISIBLE_RESULTS = 8
const PREVIEW_LINES = 20

/**
 * Quick Open dialog (ctrl+shift+p / cmd+shift+p).
 * Fuzzy file finder with a syntax-highlighted preview of the focused file.
 */
export function QuickOpenDialog({ onDone, onInsert }: Props) {
  useRegisterOverlay('quick-open')
  const { columns, rows } = useTerminalSize()
  const visibleResults = Math.min(VISIBLE_RESULTS, Math.max(4, rows - 14))
  const [results, setResults] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [focusedPath, setFocusedPath] = useState<string | undefined>(undefined)
  const [preview, setPreview] = useState<{ path: string; content: string } | null>(null)
  const queryGenRef = useRef(0)
  useEffect(
    () => () => {
      queryGenRef.current = queryGenRef.current + 1
      return void queryGenRef.current
    },
    [],
  )
  const previewOnRight = columns >= 120
  const effectivePreviewLines = previewOnRight ? VISIBLE_RESULTS - 1 : PREVIEW_LINES
  const handleQueryChange = (q: string) => {
    setQuery(q)
    const gen = (queryGenRef.current = queryGenRef.current + 1)
    if (!q.trim()) {
      setResults([])
      return
    }
    generateFileSuggestions(q, true).then((items) => {
      if (gen !== queryGenRef.current) {
        return
      }
      const paths = items
        .filter((i) => i.id.startsWith('file-'))
        .map((i_0) => i_0.displayText)
        .filter((p) => !p.endsWith(path.sep))
        .map((p_0) => p_0.split(path.sep).join('/'))
      setResults(paths)
    })
  }
  useEffect(() => {
    if (!focusedPath) {
      setPreview(null)
      return
    }
    const controller = new AbortController()
    const absolute = path.resolve(getCwd(), focusedPath)
    readFileInRange(absolute, 0, effectivePreviewLines, undefined, controller.signal)
      .then((r) => {
        if (controller.signal.aborted) {
          return
        }
        setPreview({
          path: focusedPath,
          content: r.content,
        })
      })
      .catch(() => {
        if (controller.signal.aborted) {
          return
        }
        setPreview({
          path: focusedPath,
          content: tSync('quickOpen.previewUnavailable'),
        })
      })
    return () => controller.abort()
  }, [focusedPath, effectivePreviewLines])
  const maxPathWidth = previewOnRight
    ? Math.max(20, Math.floor((columns - 10) * 0.4))
    : Math.max(20, columns - 8)
  const previewWidth = previewOnRight ? Math.max(40, columns - maxPathWidth - 14) : columns - 6
  const handleOpen = (p_1: string) => {
    const opened = openFileInExternalEditor(path.resolve(getCwd(), p_1))
    logEvent('zy_quick_open_select', {
      result_count: results.length,
      opened_editor: opened,
    })
    onDone()
  }
  const handleInsert = (p_2: string, mention: boolean) => {
    onInsert(mention ? `@${p_2} ` : `${p_2} `)
    logEvent('zy_quick_open_insert', {
      result_count: results.length,
      mention,
    })
    onDone()
  }
  return (
    <FuzzyPicker
      title={tSync('quickOpen.title')}
      placeholder={tSync('quickOpen.placeholder')}
      items={results}
      getKey={(p_3) => p_3}
      visibleCount={visibleResults}
      direction="up"
      previewPosition={previewOnRight ? 'right' : 'bottom'}
      onQueryChange={handleQueryChange}
      onFocus={setFocusedPath}
      onSelect={handleOpen}
      onTab={{
        action: tSync('quickOpen.insertMention'),
        handler: (p_4) => handleInsert(p_4, true),
      }}
      onShiftTab={{
        action: tSync('quickOpen.insertPath'),
        handler: (p_5) => handleInsert(p_5, false),
      }}
      onCancel={onDone}
      emptyMessage={(q_0) => (q_0 ? tSync('quickOpen.noResults') : tSync('quickOpen.startTyping'))}
      selectAction={tSync('quickOpen.action')}
      renderItem={(p_6, isFocused) => (
        <Text color={isFocused ? 'suggestion' : undefined}>
          {truncatePathMiddle(p_6, maxPathWidth)}
        </Text>
      )}
      renderPreview={(p_7) =>
        preview ? (
          <>
            <Text dimColor={true}>
              {truncatePathMiddle(p_7, previewWidth)}
              {preview.path !== p_7 ? ` \xB7 ${tSync('quickOpen.previewLoading')}` : ''}
            </Text>
            {preview.content.split('\n').map((line, i_1) => (
              <Text key={i_1}>{highlightMatch(truncateToWidth(line, previewWidth), query)}</Text>
            ))}
          </>
        ) : (
          <LoadingState message={tSync('quickOpen.previewLoading')} dimColor={true} />
        )
      }
    />
  )
}
