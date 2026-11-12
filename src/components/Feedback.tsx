import { homedir } from 'node:os'
import * as React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { tSync } from '../i18n/index.js'
import type { CommandResultDisplay } from '../commands/index.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { Box, Text, useInput } from '../ink/index.js'
import { setClipboard } from '../ink/termio/osc.js'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import { openBrowser } from '../services/browser/browser.js'
import { env } from '../services/environment/env.js'
import { generateFeedbackTitle } from '../services/feedback/feedbackTitle.js'
import { createIssueWithGh, isGhReady } from '../services/feedback/ghIssue.js'
import {
  buildIssueBody,
  createGitHubIssueUrl,
  type FeedbackEnvInfo,
  type FeedbackError,
  sanitizeErrors,
} from '../services/feedback/githubIssue.js'
import { getIsGit } from '../services/infra/git.js'
import { getInMemoryErrors } from '../services/infra/log.js'
import { ConfigurableShortcutHint } from './ConfigurableShortcutHint.js'
import { Byline } from './design-system/Byline.js'
import { Dialog } from './design-system/Dialog.js'
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js'
import TextInput from './TextInput.js'

type Props = {
  abortSignal: AbortSignal
  initialDescription?: string
  onDone(result: string, options?: { display?: CommandResultDisplay }): void
}

type Step = 'userInput' | 'preparing' | 'review' | 'submittingGh' | 'opening'

type Prepared = {
  title: string
  titleSource: 'model' | 'fallback'
  envInfo: FeedbackEnvInfo
  errors: FeedbackError[]
}

/**
 * /feedback：只生成 GitHub issue 预填链接（或经本机 gh 提交），
 * 不向任何反馈后端发送数据，也不上传会话记录。
 */
export function Feedback({ abortSignal, initialDescription, onDone }: Props): React.ReactNode {
  const [step, setStep] = useState<Step>('userInput')
  const [cursorOffset, setCursorOffset] = useState((initialDescription ?? '').length)
  const [description, setDescription] = useState(initialDescription ?? '')
  const [prepared, setPrepared] = useState<Prepared | null>(null)
  const [ghReady, setGhReady] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const isGitRef = useRef<Promise<boolean> | null>(null)
  const textInputColumns = useTerminalSize().columns - 4

  useEffect(() => {
    isGitRef.current = getIsGit().catch(() => false)
    let cancelled = false
    void isGhReady().then((ready) => {
      if (!cancelled) {
        setGhReady(ready)
      }
    })
    return () => {
      cancelled = true
    }
  }, [])

  const prepare = useCallback(async () => {
    if (!description.trim()) {
      return
    }
    setStep('preparing')
    setError(null)
    setNotice(null)
    const [isGit, titleResult] = await Promise.all([
      isGitRef.current ?? Promise.resolve(false),
      generateFeedbackTitle(description, abortSignal),
    ])
    if (abortSignal.aborted) {
      return
    }
    setPrepared({
      title: titleResult.title,
      titleSource: titleResult.source,
      envInfo: {
        version: MACRO.VERSION,
        platform: env.platform,
        terminal: env.terminal,
        isGit,
      },
      errors: sanitizeErrors(getInMemoryErrors(), undefined, homedir()),
    })
    setStep('review')
  }, [description, abortSignal])

  const openInBrowser = useCallback(async () => {
    if (!prepared) {
      return
    }
    setStep('opening')
    const url = createGitHubIssueUrl(prepared.title, description, prepared.envInfo, prepared.errors)
    const opened = await openBrowser(url)
    onDone(
      opened ? tSync('feedback.openedInBrowser') : tSync('feedback.openBrowserFailed', { url }),
      { display: 'system' },
    )
  }, [prepared, description, onDone])

  const submitWithGh = useCallback(async () => {
    if (!prepared) {
      return
    }
    setStep('submittingGh')
    setError(null)
    const body = buildIssueBody(description, prepared.envInfo, prepared.errors)
    const result = await createIssueWithGh(prepared.title, body)
    if (result.ok) {
      onDone(tSync('feedback.ghCreated', { url: result.url }), { display: 'system' })
      return
    }
    setError(tSync('feedback.ghFailed', { error: result.error }))
    setStep('review')
  }, [prepared, description, onDone])

  const copyToClipboard = useCallback(async () => {
    if (!prepared) {
      return
    }
    const text = `${prepared.title}\n\n${buildIssueBody(description, prepared.envInfo, prepared.errors)}`
    const raw = await setClipboard(text)
    if (raw) {
      process.stdout.write(raw)
    }
    setNotice(tSync('feedback.copied'))
  }, [prepared, description])

  const handleCancel = useCallback(() => {
    onDone(tSync('feedback.cancelled'), { display: 'system' })
  }, [onDone])

  // 输入阶段只有 Esc（而非 'n'）触发取消，保证可以在输入框里打字母 n
  useKeybinding('confirm:no', handleCancel, {
    context: 'Settings',
    isActive: step === 'userInput',
  })

  useInput((input, key) => {
    if (step !== 'review') {
      return
    }
    if (key.return) {
      void openInBrowser()
    } else if (input === 'g' && ghReady) {
      void submitWithGh()
    } else if (input === 'c') {
      void copyToClipboard()
    }
  })

  return (
    <Dialog
      title={tSync('feedback.title')}
      onCancel={handleCancel}
      isCancelActive={step !== 'userInput'}
      inputGuide={(exitState) =>
        exitState.pending ? (
          <Text>{tSync('export.pressAgainToExit', { key: exitState.keyName ?? '' })}</Text>
        ) : step === 'userInput' ? (
          <Byline>
            <KeyboardShortcutHint shortcut="Enter" action="continue" />
            <ConfigurableShortcutHint
              action="confirm:no"
              context="Confirmation"
              fallback="Esc"
              description={tSync('feedback.cancelAction')}
            />
          </Byline>
        ) : step === 'review' ? (
          <Byline>
            <KeyboardShortcutHint shortcut="Enter" actionText={tSync('feedback.openAction')} />
            {ghReady && (
              <KeyboardShortcutHint shortcut="g" actionText={tSync('feedback.ghAction')} />
            )}
            <KeyboardShortcutHint shortcut="c" actionText={tSync('feedback.copyAction')} />
            <ConfigurableShortcutHint
              action="confirm:no"
              context="Confirmation"
              fallback="Esc"
              description={tSync('feedback.cancelAction')}
            />
          </Byline>
        ) : null
      }
    >
      {step === 'userInput' && (
        <Box flexDirection="column" gap={1}>
          <Text>{tSync('feedback.describeIssue')}</Text>
          <TextInput
            value={description}
            onChange={setDescription}
            columns={textInputColumns}
            onSubmit={() => void prepare()}
            onExitMessage={() => onDone(tSync('feedback.cancelled'), { display: 'system' })}
            cursorOffset={cursorOffset}
            onChangeCursorOffset={setCursorOffset}
            showCursor
          />
          <Text dimColor>{tSync('feedback.privacyNote')}</Text>
        </Box>
      )}

      {step === 'preparing' && <Text>{tSync('feedback.preparing')}</Text>}
      {step === 'opening' && <Text>{tSync('feedback.opening')}</Text>}
      {step === 'submittingGh' && <Text>{tSync('feedback.submittingGh')}</Text>}

      {step === 'review' && prepared && (
        <Box flexDirection="column">
          <Text>
            {tSync('feedback.issueTitle')}
            <Text bold>{prepared.title}</Text>
            <Text dimColor>
              {prepared.titleSource === 'model'
                ? tSync('feedback.titleFromModel')
                : tSync('feedback.titleFromDescription')}
            </Text>
          </Text>
          <Box marginTop={1} flexDirection="column">
            <Text>{tSync('feedback.reportIncludes')}</Text>
            <Box marginLeft={2} flexDirection="column">
              <Text>
                {tSync('feedback.reportDescription')}
                <Text dimColor>{description}</Text>
              </Text>
              <Text>
                {tSync('feedback.reportEnvironment')}
                <Text dimColor>
                  {tSync('feedback.envSummary', {
                    platform: prepared.envInfo.platform,
                    terminal: prepared.envInfo.terminal ?? '?',
                    version: prepared.envInfo.version,
                    git: prepared.envInfo.isGit ? 'yes' : 'no',
                  })}
                </Text>
              </Text>
              <Text>{tSync('feedback.reportErrors', { count: prepared.errors.length })}</Text>
            </Box>
          </Box>
          <Box marginTop={1}>
            <Text dimColor wrap="wrap">
              {tSync('feedback.reportNotIncluded')}
            </Text>
          </Box>
          {notice && (
            <Box marginTop={1}>
              <Text color="success">{notice}</Text>
            </Box>
          )}
          {error && (
            <Box marginTop={1}>
              <Text color="error">{error}</Text>
            </Box>
          )}
        </Box>
      )}
    </Dialog>
  )
}
