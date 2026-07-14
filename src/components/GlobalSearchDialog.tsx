import { resolve as resolvePath } from 'node:path'
import { useEffect, useRef, useState } from 'react'
import { useRegisterOverlay } from '../context/OverlayContext.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { tSync } from '../i18n/index.js'
import { Text } from '../ink.js'
import { logEvent } from '../services/analytics/index.js'
import { getCwd } from '../utils/cwd.js'
import { openFileInExternalEditor } from '../terminal-ui/editor.js'
import { truncatePathMiddle, truncateToWidth } from '../utils/format.js'
import { highlightMatch } from '../components/Runtime/HighlightMatch.js'
import { relativePath } from '../services/permissions/filesystem.js'
import { readFileInRange } from '../utils/readFileInRange.js'
import { ripGrepStream } from '../utils/ripgrep.js'
import { FuzzyPicker } from './design-system/FuzzyPicker.js'
import { LoadingState } from './design-system/LoadingState.js'

type Props = {
  onDone: () => void
  onInsert: (text: string) => void
}
type Match = {
  file: string
  line: number
  text: string
}
const VISIBLE_RESULTS = 12
const DEBOUNCE_MS = 100
const PREVIEW_CONTEXT_LINES = 4
// rg -m is per-file; we also cap the parsed array to keep memory bounded.
const MAX_MATCHES_PER_FILE = 10
const MAX_TOTAL_MATCHES = 500

/**
 * Global Search dialog (ctrl+shift+f / cmd+shift+f).
 * Debounced ripgrep search across the workspace.
 */
export function GlobalSearchDialog({ onDone, onInsert }: Props) {
  useRegisterOverlay('global-search')
  const { columns, rows } = useTerminalSize()
  const previewOnRight = columns >= 140
  const visibleResults = Math.min(VISIBLE_RESULTS, Math.max(4, rows - 14))
  const [matches, setMatches] = useState<Match[]>([])
  const [truncated, setTruncated] = useState(false)
  const [isSearching, setIsSearching] = useState(false)
  const [query, setQuery] = useState('')
  const [focused, setFocused] = useState<Match | undefined>(undefined)
  const [preview, setPreview] = useState<{ file: string; line: number; content: string } | null>(
    null,
  )
  const abortRef = useRef<AbortController | null>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current)
      }
      abortRef.current?.abort()
    },
    [],
  )
  useEffect(() => {
    if (!focused) {
      setPreview(null)
      return
    }
    const controller = new AbortController()
    const absolute = resolvePath(getCwd(), focused.file)
    const start = Math.max(0, focused.line - PREVIEW_CONTEXT_LINES - 1)
    readFileInRange(absolute, start, PREVIEW_CONTEXT_LINES * 2 + 1, undefined, controller.signal)
      .then((r) => {
        if (controller.signal.aborted) {
          return
        }
        setPreview({
          file: focused.file,
          line: focused.line,
          content: r.content,
        })
      })
      .catch(() => {
        if (controller.signal.aborted) {
          return
        }
        setPreview({
          file: focused.file,
          line: focused.line,
          content: tSync('globalSearch.previewUnavailable'),
        })
      })
    return () => controller.abort()
  }, [focused])
  const handleQueryChange = (q: string) => {
    setQuery(q)
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current)
    }
    abortRef.current?.abort()
    if (!q.trim()) {
      setMatches((m) => (m.length ? [] : m))
      setIsSearching(false)
      setTruncated(false)
      return
    }
    const controller_0 = new AbortController()
    abortRef.current = controller_0
    setIsSearching(true)
    setTruncated(false)
    const queryLower = q.toLowerCase()
    setMatches((m_0) => {
      const filtered = m_0.filter((match) => match.text.toLowerCase().includes(queryLower))
      return filtered.length === m_0.length ? m_0 : filtered
    })
    timeoutRef.current = setTimeout(
      (query_0, controller_1, setMatches_0, setTruncated_0, setIsSearching_0) => {
        const cwd = getCwd()
        let collected = 0
        ripGrepStream(
          ['-n', '--no-heading', '-i', '-m', String(MAX_MATCHES_PER_FILE), '-F', '-e', query_0],
          cwd,
          controller_1.signal,
          (lines) => {
            if (controller_1.signal.aborted) {
              return
            }
            const parsed: Match[] = []
            for (const line of lines) {
              const m_1 = parseRipgrepLine(line)
              if (!m_1) {
                continue
              }
              const rel = relativePath(cwd, m_1.file)
              parsed.push({
                ...m_1,
                file: rel.startsWith('..') ? m_1.file : rel,
              })
            }
            if (!parsed.length) {
              return
            }
            collected = collected + parsed.length
            setMatches_0((prev) => {
              const seen = new Set(prev.map(matchKey))
              const fresh = parsed.filter((p) => !seen.has(matchKey(p)))
              if (!fresh.length) {
                return prev
              }
              const next = prev.concat(fresh)
              return next.length > MAX_TOTAL_MATCHES ? next.slice(0, MAX_TOTAL_MATCHES) : next
            })
            if (collected >= MAX_TOTAL_MATCHES) {
              controller_1.abort()
              setTruncated_0(true)
              setIsSearching_0(false)
            }
          },
        )
          .catch(_temp2)
          .finally(() => {
            if (controller_1.signal.aborted) {
              return
            }
            if (collected === 0) {
              setMatches_0((m_2) => (m_2.length ? [] : m_2))
            }
            setIsSearching_0(false)
          })
      },
      DEBOUNCE_MS,
      q,
      controller_0,
      setMatches,
      setTruncated,
      setIsSearching,
    )
  }
  const listWidth = previewOnRight ? Math.floor((columns - 10) * 0.5) : columns - 8
  const maxPathWidth = Math.max(20, Math.floor(listWidth * 0.4))
  const maxTextWidth = Math.max(20, listWidth - maxPathWidth - 4)
  const previewWidth = previewOnRight ? Math.max(40, columns - listWidth - 14) : columns - 6
  const handleOpen = (m_3: Match) => {
    const opened = openFileInExternalEditor(resolvePath(getCwd(), m_3.file), m_3.line)
    logEvent('zy_global_search_select', {
      result_count: matches.length,
      opened_editor: opened,
    })
    onDone()
  }
  const handleInsert = (m_4: Match, mention: boolean) => {
    onInsert(mention ? `@${m_4.file}#L${m_4.line} ` : `${m_4.file}:${m_4.line} `)
    logEvent('zy_global_search_insert', {
      result_count: matches.length,
      mention,
    })
    onDone()
  }
  const matchLabel =
    matches.length > 0
      ? `${matches.length}${truncated ? tSync('globalSearch.matchesTruncated') : ''} ${tSync('globalSearch.matches', { count: matches.length })}${isSearching ? '\u2026' : ''}`
      : ' '
  return (
    <FuzzyPicker
      title={tSync('globalSearch.title')}
      placeholder={tSync('globalSearch.placeholder')}
      items={matches}
      getKey={matchKey}
      visibleCount={visibleResults}
      direction="up"
      previewPosition={previewOnRight ? 'right' : 'bottom'}
      onQueryChange={handleQueryChange}
      onFocus={setFocused}
      onSelect={handleOpen}
      onTab={{
        action: tSync('globalSearch.mention'),
        handler: (m_5) => handleInsert(m_5, true),
      }}
      onShiftTab={{
        action: tSync('globalSearch.insertPath'),
        handler: (m_6) => handleInsert(m_6, false),
      }}
      onCancel={onDone}
      emptyMessage={(q_0) =>
        isSearching
          ? tSync('globalSearch.searching')
          : q_0
            ? tSync('globalSearch.noMatches')
            : tSync('globalSearch.typeToSearch')
      }
      matchLabel={matchLabel}
      selectAction={tSync('globalSearch.openInEditor')}
      renderItem={(m_7, isFocused) => (
        <Text color={isFocused ? 'suggestion' : undefined}>
          <Text dimColor={true}>
            {truncatePathMiddle(m_7.file, maxPathWidth)}:{m_7.line}
          </Text>{' '}
          {highlightMatch(truncateToWidth(m_7.text.trimStart(), maxTextWidth), query)}
        </Text>
      )}
      renderPreview={(m_8) =>
        preview?.file === m_8.file && preview.line === m_8.line ? (
          <>
            <Text dimColor={true}>
              {truncatePathMiddle(m_8.file, previewWidth)}:{m_8.line}
            </Text>
            {preview.content.split('\n').map((line_0, i) => (
              <Text key={i}>{highlightMatch(truncateToWidth(line_0, previewWidth), query)}</Text>
            ))}
          </>
        ) : (
          <LoadingState message={tSync('globalSearch.loading')} dimColor={true} />
        )
      }
    />
  )
}
function _temp2() {}
function matchKey(m: Match): string {
  return `${m.file}:${m.line}`
}

/**
 * Parse a ripgrep -n --no-heading output line: "path:line:text".
 * Windows paths may contain a drive letter ("C:\..."), so a simple split on
 * the first colon would mangle the path — use a regex that captures up to
 * the first :<digits>: instead.
 * @internal exported for testing
 */
export function parseRipgrepLine(line: string): Match | null {
  const m = /^(.*?):(\d+):(.*)$/.exec(line)
  if (!m) {
    return null
  }
  const [, file, lineStr, text] = m
  const lineNum = Number(lineStr)
  if (!file || !Number.isFinite(lineNum)) {
    return null
  }
  return {
    file,
    line: lineNum,
    text: text ?? '',
  }
}
