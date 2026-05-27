import * as React from 'react'
import { useCallback, useMemo, useState } from 'react'
import { Select } from '../../components/CustomSelect/select.js'
import { Markdown } from '../../components/Markdown.js'
import { tSync } from '../../i18n/index.js'
import { Box, Text, useInput } from '../../ink.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import { getLessonFrames } from './frames.js'
import { LessonFrames } from './LessonFrames.js'

interface PowerupLesson {
  id: string
  i18nKey: string
  title: string
  tagline: string
  body: string
}

// id 为 kebab-case，会被持久化到 powerupsUnlocked，不能改；
// i18nKey 为 camelCase，只用于拼 i18n key 段。
const LESSON_REGISTRY = [
  { id: 'at-mentions', i18nKey: 'atMentions' },
  { id: 'modes', i18nKey: 'modes' },
  { id: 'undo', i18nKey: 'undo' },
  { id: 'background', i18nKey: 'background' },
  { id: 'memory', i18nKey: 'memory' },
  { id: 'mcp', i18nKey: 'mcp' },
  { id: 'automate', i18nKey: 'automate' },
  { id: 'subagents', i18nKey: 'subagents' },
  { id: 'cross-device', i18nKey: 'crossDevice' },
  { id: 'model-dial', i18nKey: 'modelDial' },
] as const

function getLessons(): PowerupLesson[] {
  return LESSON_REGISTRY.map(({ id, i18nKey }) => ({
    id,
    i18nKey,
    title: tSync(`powerup.lesson.${i18nKey}.title`),
    tagline: tSync(`powerup.lesson.${i18nKey}.tagline`),
    body: tSync(`powerup.lesson.${i18nKey}.body`),
  }))
}

function loadUnlocked(): Set<string> {
  const stored = getGlobalConfig().powerupsUnlocked ?? []
  const valid = new Set<string>(LESSON_REGISTRY.map((l) => l.id))
  return new Set(stored.filter((id) => valid.has(id)))
}

function persistUnlocked(next: Set<string>): void {
  saveGlobalConfig((config) => ({
    ...config,
    powerupsUnlocked: [...next],
  }))
}

type Props = { onDone: LocalJSXCommandOnDone }

function PowerupApp({ onDone }: Props) {
  const lessons = getLessons()
  const [unlocked, setUnlocked] = useState<Set<string>>(() => loadUnlocked())
  const [openLessonId, setOpenLessonId] = useState<string | null>(null)
  const [focusId, setFocusId] = useState<string>(lessons[0].id)

  const total = lessons.length
  const completed = unlocked.size
  const allDone = completed === total

  const close = useCallback(() => {
    onDone(tSync('powerup.closed'), { display: 'system' })
  }, [onDone])

  const markDone = useCallback((id: string) => {
    setUnlocked((prev) => {
      if (prev.has(id)) return prev
      const next = new Set(prev)
      next.add(id)
      persistUnlocked(next)
      return next
    })
  }, [])

  const options = useMemo(
    () =>
      lessons.map((lesson) => {
        const done = unlocked.has(lesson.id)
        return {
          value: lesson.id,
          label: done ? (
            <Text>
              <Text color="success">●</Text> {lesson.title}
            </Text>
          ) : (
            <Text>◯ {lesson.title}</Text>
          ),
          description: lesson.tagline,
        }
      }),
    [lessons, unlocked],
  )

  const openLesson = lessons.find((l) => l.id === openLessonId) ?? null

  // eslint-disable-next-line custom-rules/prefer-use-keybindings -- raw y/n/Esc keystrokes inside detail view
  useInput(
    (input, key) => {
      if (!openLesson) return
      if (key.escape || input === 'n' || input === 'N') {
        setOpenLessonId(null)
        return
      }
      if (key.return || input === 'y' || input === 'Y') {
        markDone(openLesson.id)
        setOpenLessonId(null)
      }
    },
    { isActive: openLesson !== null },
  )

  if (openLesson) {
    const isUnlocked = unlocked.has(openLesson.id)
    const badge = isUnlocked ? tSync('powerup.unlockedBadge') : tSync('powerup.todoBadge')
    const frames = getLessonFrames(openLesson.i18nKey)
    return (
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        <Text bold color="zy">
          {openLesson.title}
        </Text>
        <Text color="subtle">
          {openLesson.tagline} · {badge}
        </Text>
        {frames.length > 0 && (
          <Box marginTop={1}>
            <LessonFrames key={openLesson.id} frames={frames} />
          </Box>
        )}
        <Box marginTop={1}>
          <Markdown>{openLesson.body}</Markdown>
        </Box>
        <Box marginTop={1}>
          <Text color="subtle">{tSync('powerup.detailHint')}</Text>
        </Box>
      </Box>
    )
  }

  const progressLabel = tSync('powerup.progressLabel', {
    completed: String(completed),
    total: String(total),
  })

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Box flexDirection="row" gap={1}>
        <Text bold color="zy">
          {allDone ? tSync('powerup.titleAll') : tSync('powerup.title')}
        </Text>
        <Text color="subtle">{progressLabel}</Text>
      </Box>
      <Box marginTop={1}>
        <Text color="subtle">
          {allDone ? tSync('powerup.subtitleAll') : tSync('powerup.subtitle')}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Select
          options={options}
          defaultFocusValue={focusId}
          onFocus={setFocusId}
          onChange={(id) => setOpenLessonId(id)}
          onCancel={close}
          hideIndexes
          visibleOptionCount={lessons.length}
        />
      </Box>
    </Box>
  )
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  _context: unknown,
  _args?: string,
): Promise<React.ReactNode> {
  return <PowerupApp onDone={onDone} />
}
