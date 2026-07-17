import { randomUUID, type UUID } from 'node:crypto'
import { basename } from 'node:path'
import * as React from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { tSync } from 'src/i18n/index.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from 'src/services/analytics/index.js'
import { useAppState } from 'src/state/AppState.js'
import {
  type DiffStats,
  fileHistoryCanRestore,
  fileHistoryEnabled,
  fileHistoryGetDiffStats,
} from 'src/services/file-persistence/fileHistory.js'
import { logError } from 'src/utils/log.js'
import { POINTER, WARNING } from '../constants/figures.js'
import { useExitOnCtrlCDWithKeybindings } from '../hooks/useExitOnCtrlCDWithKeybindings.js'
import { Box, Text } from '../ink/index.js'
import { useKeybinding, useKeybindings } from '../keybindings/useKeybinding.js'
import type { Message, PartialCompactDirection, UserMessage } from '../types/message.js'
import { createUserMessage } from '../services/messages/./constructors.js'
import { type OptionWithDescription, Select } from './CustomSelect/select.js'
import { Spinner } from './Spinner.js'
import { formatRelativeTimeAgo } from '../utils/format.js'
import { validateUuid } from '../utils/uuid.js'
import { Divider } from './design-system/Divider.js'
import {
  DiffStatsText,
  RestoreOptionDescription,
  UserMessageOption,
} from './MessageSelectorDetails.js'
import {
  computeDiffStatsBetweenMessages,
  isSummarizeOption,
  messagesAfterAreOnlySynthetic,
  type RestoreOption,
  selectableUserMessagesFilter,
} from './messageSelectorUtils.js'
export {
  messagesAfterAreOnlySynthetic,
  selectableUserMessagesFilter,
} from './messageSelectorUtils.js'

type Props = {
  messages: Message[]
  onPreRestore: () => void
  onRestoreMessage: (message: UserMessage) => Promise<void>
  onRestoreCode: (message: UserMessage) => Promise<void>
  onSummarize: (
    message: UserMessage,
    feedback?: string,
    direction?: PartialCompactDirection,
  ) => Promise<void>
  onClose: () => void
  /** Skip pick-list, land on confirm. Caller ran skip-check first. Esc closes fully (no back-to-list). */
  preselectedMessage?: UserMessage
}
const MAX_VISIBLE_MESSAGES = 7

function getValidatedMessageUuid(message: Pick<UserMessage, 'uuid'>): UUID | undefined {
  // 历史会话可能来自旧日志或外部导入，进入 file history 前先做一次运行时收窄。
  return validateUuid(message.uuid) ?? undefined
}

export function MessageSelector({
  messages,
  onPreRestore,
  onRestoreMessage,
  onRestoreCode,
  onSummarize,
  onClose,
  preselectedMessage,
}: Props): React.ReactNode {
  const fileHistory = useAppState((s) => s.fileHistory)
  const [error, setError] = useState<string | undefined>(undefined)
  const isFileHistoryEnabled = fileHistoryEnabled()

  // Add current prompt as a virtual message
  const currentUUID = useMemo(randomUUID, [])
  const messageOptions = useMemo(
    () => [
      ...messages.filter(selectableUserMessagesFilter),
      {
        ...createUserMessage({
          content: [{ type: 'text' as const, text: '' }],
        }),
        uuid: currentUUID,
      } as UserMessage,
    ],
    [messages, currentUUID],
  )
  const [selectedIndex, setSelectedIndex] = useState(messageOptions.length - 1)

  // Orient the selected message as the middle of the visible options
  const firstVisibleIndex = Math.max(
    0,
    Math.min(
      selectedIndex - Math.floor(MAX_VISIBLE_MESSAGES / 2),
      messageOptions.length - MAX_VISIBLE_MESSAGES,
    ),
  )
  const hasMessagesToSelect = messageOptions.length > 1
  const [messageToRestore, setMessageToRestore] = useState<UserMessage | undefined>(
    preselectedMessage,
  )
  const [diffStatsForRestore, setDiffStatsForRestore] = useState<DiffStats | undefined>(undefined)
  useEffect(() => {
    if (!preselectedMessage || !isFileHistoryEnabled) {
      return
    }
    const preselectedMessageId = getValidatedMessageUuid(preselectedMessage)
    if (!preselectedMessageId) {
      return
    }
    let cancelled = false
    void fileHistoryGetDiffStats(fileHistory, preselectedMessageId).then((stats) => {
      if (!cancelled) {
        setDiffStatsForRestore(stats)
      }
    })
    return () => {
      cancelled = true
    }
  }, [preselectedMessage, isFileHistoryEnabled, fileHistory])
  const [isRestoring, setIsRestoring] = useState(false)
  const [restoringOption, setRestoringOption] = useState<RestoreOption | null>(null)
  const [selectedRestoreOption, setSelectedRestoreOption] = useState<RestoreOption>('both')
  // Per-option feedback state; Select's internal inputValues Map persists
  // per-option text independently, so sharing one variable would desync.
  const [summarizeFromFeedback, setSummarizeFromFeedback] = useState('')
  const [summarizeUpToFeedback, setSummarizeUpToFeedback] = useState('')

  // Generate options with summarize as input type for inline context
  function getRestoreOptions(canRestoreCode: boolean): OptionWithDescription<RestoreOption>[] {
    const baseOptions: OptionWithDescription<RestoreOption>[] = canRestoreCode
      ? [
          {
            value: 'both',
            label: tSync('messageSelector.restoreCodeAndConversation'),
          },
          {
            value: 'conversation',
            label: tSync('messageSelector.restoreConversation'),
          },
          {
            value: 'code',
            label: tSync('messageSelector.restoreCode'),
          },
        ]
      : [
          {
            value: 'conversation',
            label: tSync('messageSelector.restoreConversation'),
          },
        ]
    const summarizeInputProps = {
      type: 'input' as const,
      placeholder: tSync('messageSelector.addContextPlaceholder'),
      initialValue: '',
      allowEmptySubmitToCancel: true,
      showLabelWithValue: true,
      labelValueSeparator: ': ',
    }
    baseOptions.push({
      value: 'summarize',
      label: tSync('messageSelector.summarizeFromHere'),
      ...summarizeInputProps,
      onChange: setSummarizeFromFeedback,
    })
    baseOptions.push({
      value: 'summarize_up_to',
      label: tSync('messageSelector.summarizeUpToHere'),
      ...summarizeInputProps,
      onChange: setSummarizeUpToFeedback,
    })
    baseOptions.push({
      value: 'nevermind',
      label: tSync('messageSelector.nevermind'),
    })
    return baseOptions
  }

  // Log when selector is opened
  useEffect(() => {
    logEvent('zy_message_selector_opened', {})
  }, [])

  // Helper to restore conversation without confirmation
  async function restoreConversationDirectly(message: UserMessage) {
    onPreRestore()
    setIsRestoring(true)
    try {
      await onRestoreMessage(message)
      setIsRestoring(false)
      onClose()
    } catch (restoreError) {
      logError(restoreError as Error)
      setIsRestoring(false)
      setError(
        tSync('messageSelector.restoreConversationFailed', {
          error: String(restoreError),
        }),
      )
    }
  }
  async function handleSelect(message_0: UserMessage) {
    const index = messages.indexOf(message_0)
    const indexFromEnd = messages.length - 1 - index
    logEvent('zy_message_selector_selected', {
      index_from_end: indexFromEnd,
      message_type: message_0.type as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      is_current_prompt: false,
    })

    // Do nothing if the message is not found
    if (!messages.includes(message_0)) {
      onClose()
      return
    }
    if (!isFileHistoryEnabled) {
      await restoreConversationDirectly(message_0)
      return
    }
    const messageId = getValidatedMessageUuid(message_0)
    if (!messageId) {
      setError(tSync('messageSelector.messageNotFound'))
      return
    }
    const diffStats = await fileHistoryGetDiffStats(fileHistory, messageId)
    setMessageToRestore(message_0)
    setDiffStatsForRestore(diffStats)
  }
  async function onSelectRestoreOption(option: RestoreOption) {
    logEvent('zy_message_selector_restore_option_selected', {
      option: option as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    if (!messageToRestore) {
      setError(tSync('messageSelector.messageNotFound'))
      return
    }
    if (option === 'nevermind') {
      if (preselectedMessage) {
        onClose()
      } else {
        setMessageToRestore(undefined)
      }
      return
    }
    if (isSummarizeOption(option)) {
      onPreRestore()
      setIsRestoring(true)
      setRestoringOption(option)
      setError(undefined)
      try {
        const direction: PartialCompactDirection = option === 'summarize_up_to' ? 'up_to' : 'from'
        const feedback =
          (direction === 'up_to' ? summarizeUpToFeedback : summarizeFromFeedback).trim() ||
          undefined
        await onSummarize(messageToRestore, feedback, direction)
        setIsRestoring(false)
        setRestoringOption(null)
        setMessageToRestore(undefined)
        onClose()
      } catch (summarizeError) {
        logError(summarizeError as Error)
        setIsRestoring(false)
        setRestoringOption(null)
        setMessageToRestore(undefined)
        setError(
          tSync('messageSelector.summarizeFailed', {
            error: String(summarizeError),
          }),
        )
      }
      return
    }
    onPreRestore()
    setIsRestoring(true)
    setError(undefined)
    let codeError: Error | null = null
    let conversationError: Error | null = null
    if (option === 'code' || option === 'both') {
      try {
        await onRestoreCode(messageToRestore)
      } catch (error_2) {
        codeError = error_2 as Error
        logError(codeError)
      }
    }
    if (option === 'conversation' || option === 'both') {
      try {
        await onRestoreMessage(messageToRestore)
      } catch (error_3) {
        conversationError = error_3 as Error
        logError(conversationError)
      }
    }
    setIsRestoring(false)
    setMessageToRestore(undefined)

    // Handle errors
    if (conversationError && codeError) {
      setError(
        tSync('messageSelector.restoreConversationAndCodeFailed', {
          conversationError: String(conversationError),
          codeError: String(codeError),
        }),
      )
    } else if (conversationError) {
      setError(
        tSync('messageSelector.restoreConversationFailed', {
          error: String(conversationError),
        }),
      )
    } else if (codeError) {
      setError(
        tSync('messageSelector.restoreCodeFailed', {
          error: String(codeError),
        }),
      )
    } else {
      // Success - close the selector
      onClose()
    }
  }
  const exitState = useExitOnCtrlCDWithKeybindings()
  const handleEscape = useCallback(() => {
    if (messageToRestore && !preselectedMessage) {
      // Go back to message list instead of closing entirely
      setMessageToRestore(undefined)
      return
    }
    logEvent('zy_message_selector_cancelled', {})
    onClose()
  }, [onClose, messageToRestore, preselectedMessage])
  const moveUp = useCallback(() => setSelectedIndex((prev) => Math.max(0, prev - 1)), [])
  const moveDown = useCallback(
    () => setSelectedIndex((prev_0) => Math.min(messageOptions.length - 1, prev_0 + 1)),
    [messageOptions.length],
  )
  const jumpToTop = useCallback(() => setSelectedIndex(0), [])
  const jumpToBottom = useCallback(
    () => setSelectedIndex(messageOptions.length - 1),
    [messageOptions.length],
  )
  const handleSelectCurrent = useCallback(() => {
    const selected = messageOptions[selectedIndex]
    if (selected) {
      void handleSelect(selected)
    }
  }, [messageOptions, selectedIndex, handleSelect])

  // Escape to close - uses Confirmation context where escape is bound
  useKeybinding('confirm:no', handleEscape, {
    context: 'Confirmation',
    isActive: !messageToRestore,
  })

  // Message selector navigation keybindings
  useKeybindings(
    {
      'messageSelector:up': moveUp,
      'messageSelector:down': moveDown,
      'messageSelector:top': jumpToTop,
      'messageSelector:bottom': jumpToBottom,
      'messageSelector:select': handleSelectCurrent,
    },
    {
      context: 'MessageSelector',
      isActive: !isRestoring && !error && !messageToRestore && hasMessagesToSelect,
    },
  )
  const [fileHistoryMetadata, setFileHistoryMetadata] = useState<Record<number, DiffStats>>({})
  useEffect(() => {
    async function loadFileHistoryMetadata() {
      if (!isFileHistoryEnabled) {
        return
      }
      // Load file snapshot metadata
      void Promise.all(
        messageOptions.map(async (userMessage, itemIndex) => {
          if (userMessage.uuid !== currentUUID) {
            const userMessageId = getValidatedMessageUuid(userMessage)
            if (!userMessageId) {
              setFileHistoryMetadata((prev) => ({
                ...prev,
                [itemIndex]: undefined,
              }))
              return
            }
            const canRestore = fileHistoryCanRestore(fileHistory, userMessageId)
            const nextUserMessage = messageOptions.at(itemIndex + 1)
            const nextUserMessageId = nextUserMessage
              ? getValidatedMessageUuid(nextUserMessage)
              : undefined
            const diffStats_0 = canRestore
              ? computeDiffStatsBetweenMessages(
                  messages,
                  userMessageId,
                  nextUserMessageId !== currentUUID ? nextUserMessageId : undefined,
                )
              : undefined
            if (diffStats_0 !== undefined) {
              setFileHistoryMetadata((prev_1) => ({
                ...prev_1,
                [itemIndex]: diffStats_0,
              }))
            } else {
              setFileHistoryMetadata((prev_2) => ({
                ...prev_2,
                [itemIndex]: undefined,
              }))
            }
          }
        }),
      )
    }
    void loadFileHistoryMetadata()
  }, [messageOptions, messages, currentUUID, fileHistory, isFileHistoryEnabled])
  const canRestoreCode_0 =
    isFileHistoryEnabled &&
    diffStatsForRestore?.filesChanged &&
    diffStatsForRestore.filesChanged.length > 0
  const showPickList = !error && !messageToRestore && !preselectedMessage && hasMessagesToSelect
  return (
    <Box flexDirection="column" width="100%">
      <Divider color="suggestion" />
      <Box flexDirection="column" marginX={1} gap={1}>
        <Text bold color="suggestion">
          {tSync('messageSelector.rewindTitle')}
        </Text>

        {error && (
          <Text color="error">
            {tSync('messageSelector.errorPrefix')} {error}
          </Text>
        )}
        {!hasMessagesToSelect && <Text>{tSync('messageSelector.nothingToRewind')}</Text>}
        {!error && messageToRestore && hasMessagesToSelect && (
          <>
            <Text>
              {tSync('messageSelector.confirmRestore', {
                what: !diffStatsForRestore ? tSync('messageSelector.conversation') : '',
              })}
            </Text>
            <Box
              flexDirection="column"
              paddingLeft={1}
              borderStyle="single"
              borderRight={false}
              borderTop={false}
              borderBottom={false}
              borderLeft={true}
              borderLeftDimColor
            >
              {/* @ts-ignore */}
              <UserMessageOption userMessage={messageToRestore} color="text" isCurrent={false} />
              <Text dimColor>({formatRelativeTimeAgo(new Date(messageToRestore.timestamp))})</Text>
            </Box>
            <RestoreOptionDescription
              selectedRestoreOption={selectedRestoreOption}
              canRestoreCode={!!canRestoreCode_0}
              diffStatsForRestore={diffStatsForRestore}
            />
            {isRestoring && isSummarizeOption(restoringOption) ? (
              <Box flexDirection="row" gap={1}>
                <Spinner />
                <Text>{tSync('messageSelector.summarizing')}</Text>
              </Box>
            ) : (
              <Select
                isDisabled={isRestoring}
                options={getRestoreOptions(!!canRestoreCode_0)}
                defaultFocusValue={canRestoreCode_0 ? 'both' : 'conversation'}
                onFocus={(value: string) => setSelectedRestoreOption(value as RestoreOption)}
                onChange={(value_0: string) => onSelectRestoreOption(value_0 as RestoreOption)}
                onCancel={() => (preselectedMessage ? onClose() : setMessageToRestore(undefined))}
              />
            )}
            {canRestoreCode_0 && (
              <Box marginBottom={1}>
                <Text dimColor>
                  {WARNING} {tSync('messageSelector.rewindNoBashFiles')}
                </Text>
              </Box>
            )}
          </>
        )}
        {showPickList && (
          <>
            {isFileHistoryEnabled ? (
              <Text>{tSync('messageSelector.restoreCodeOrConversation')}</Text>
            ) : (
              <Text>{tSync('messageSelector.restoreAndFork')}</Text>
            )}
            <Box width="100%" flexDirection="column">
              {messageOptions
                .slice(firstVisibleIndex, firstVisibleIndex + MAX_VISIBLE_MESSAGES)
                .map((msg, visibleOptionIndex) => {
                  const optionIndex = firstVisibleIndex + visibleOptionIndex
                  const isSelected = optionIndex === selectedIndex
                  const isCurrent = msg.uuid === currentUUID
                  const metadataLoaded = optionIndex in fileHistoryMetadata
                  const metadata = fileHistoryMetadata[optionIndex]
                  const numFilesChanged = metadata?.filesChanged?.length
                  return (
                    <Box
                      key={msg.uuid}
                      height={isFileHistoryEnabled ? 3 : 2}
                      overflow="hidden"
                      width="100%"
                      flexDirection="row"
                    >
                      <Box width={2} minWidth={2}>
                        {isSelected ? (
                          <Text color="permission" bold>
                            {POINTER}{' '}
                          </Text>
                        ) : (
                          <Text>{'  '}</Text>
                        )}
                      </Box>
                      <Box flexDirection="column">
                        <Box flexShrink={1} height={1} overflow="hidden">
                          {/* @ts-ignore */}
                          <UserMessageOption
                            userMessage={msg}
                            color={isSelected ? 'suggestion' : undefined}
                            isCurrent={isCurrent}
                            paddingRight={10}
                          />
                        </Box>
                        {isFileHistoryEnabled && metadataLoaded && (
                          <Box height={1} flexDirection="row">
                            {metadata ? (
                              <Text dimColor={!isSelected} color="inactive">
                                {numFilesChanged ? (
                                  <>
                                    {numFilesChanged === 1 && metadata.filesChanged![0]
                                      ? `${basename(metadata.filesChanged![0])} `
                                      : `${tSync('messageSelector.filesChanged', {
                                          count: numFilesChanged,
                                        })} `}
                                    <DiffStatsText diffStats={metadata} />
                                  </>
                                ) : (
                                  tSync('messageSelector.noCodeChanges')
                                )}
                              </Text>
                            ) : (
                              <Text dimColor color="warning">
                                {WARNING} {tSync('messageSelector.noCodeRestore')}
                              </Text>
                            )}
                          </Box>
                        )}
                      </Box>
                    </Box>
                  )
                })}
            </Box>
          </>
        )}
        {!messageToRestore && (
          <Text dimColor italic>
            {exitState.pending ? (
              tSync('messageSelector.pressAgainToExit', { keyName: exitState.keyName ?? '' })
            ) : (
              <>
                {!error && hasMessagesToSelect && <>{tSync('messageSelector.enterToContinue')} </>}
                {tSync('messageSelector.escToExit')}
              </>
            )}
          </Text>
        )}
      </Box>
    </Box>
  )
}
