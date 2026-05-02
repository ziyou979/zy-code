import { join } from 'path'
import React, { useCallback, useState } from 'react'
import type { ExitState } from '../hooks/useExitOnCtrlCDWithKeybindings.js'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { setClipboard } from '../ink/termio/osc.js'
import { Box, Text } from '../ink.js'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import { getCwd } from '../utils/cwd.js'
import { writeFileSync_DEPRECATED } from '../utils/slowOperations.js'
import { ConfigurableShortcutHint } from './ConfigurableShortcutHint.js'
import { Select } from './CustomSelect/select.js'
import { Byline } from './design-system/Byline.js'
import { Dialog } from './design-system/Dialog.js'
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js'
import TextInput from './TextInput.js'
import { tSync } from 'src/i18n/index.js'
type ExportDialogProps = {
  content: string
  defaultFilename: string
  onDone: (result: { success: boolean; message: string }) => void
}
type ExportOption = 'clipboard' | 'file'
export function ExportDialog({
  content,
  defaultFilename,
  onDone,
}: ExportDialogProps): React.ReactNode {
  const [, setSelectedOption] = useState<ExportOption | null>(null)
  const [filename, setFilename] = useState<string>(defaultFilename)
  const [cursorOffset, setCursorOffset] = useState<number>(defaultFilename.length)
  const [showFilenameInput, setShowFilenameInput] = useState(false)
  const { columns } = useTerminalSize()

  // 处理从文件名输入返回到选项选择
  const handleGoBack = useCallback(() => {
    setShowFilenameInput(false)
    setSelectedOption(null)
  }, [])
  const handleSelectOption = async (value: string): Promise<void> => {
    if (value === 'clipboard') {
      // 立即复制到剪贴板
      const raw = await setClipboard(content)
      if (raw) process.stdout.write(raw)
      onDone({
        success: true,
        message: tSync('export.successClipboard'),
      })
    } else if (value === 'file') {
      setSelectedOption('file')
      setShowFilenameInput(true)
    }
  }
  const handleFilenameSubmit = () => {
    const finalFilename = filename.endsWith('.txt')
      ? filename
      : filename.replace(/\.[^.]+$/, '') + '.txt'
    const filepath = join(getCwd(), finalFilename)
    try {
      writeFileSync_DEPRECATED(filepath, content, {
        encoding: 'utf-8',
        flush: true,
      })
      onDone({
        success: true,
        message: tSync('export.successFile', { filepath }),
      })
    } catch (error) {
      onDone({
        success: false,
        message: tSync('export.failedFile', {
          error: error instanceof Error ? error.message : 'Unknown error',
        }),
      })
    }
  }

  // 按 Escape 时对话框调用 onCancel。如果我们在文件名输入子屏幕，
  // 返回选项列表而不是完全关闭。
  const handleCancel = useCallback(() => {
    if (showFilenameInput) {
      handleGoBack()
    } else {
      onDone({
        success: false,
        message: tSync('export.cancelled'),
      })
    }
  }, [showFilenameInput, handleGoBack, onDone])
  const options = [
    {
      label: tSync('export.copyToClipboard'),
      value: 'clipboard',
      description: tSync('export.copyToClipboardDesc'),
    },
    {
      label: tSync('export.saveToFile'),
      value: 'file',
      description: tSync('export.saveToFileDesc'),
    },
  ]

  // 根据对话框状态变化的自定义输入指南
  function renderInputGuide(exitState: ExitState): React.ReactNode {
    if (showFilenameInput) {
      return (
        <Byline>
          <KeyboardShortcutHint shortcut="Enter" action="save" />
          <ConfigurableShortcutHint
            action="confirm:no"
            context="Confirmation"
            fallback="Esc"
            description={tSync('export.goBack')}
          />
        </Byline>
      )
    }
    if (exitState.pending) {
      return <Text>{tSync('export.pressAgainToExit', { key: exitState.keyName })}</Text>
    }
    return (
      <ConfigurableShortcutHint
        action="confirm:no"
        context="Confirmation"
        fallback="Esc"
        description={tSync('export.cancelAction')}
      />
    )
  }

  // 使用 Settings 上下文，这样 'n' 键不会取消（允许在文件名输入中输入 'n'）
  useKeybinding('confirm:no', handleCancel, {
    context: 'Settings',
    isActive: showFilenameInput,
  })
  return (
    <Dialog
      title={tSync('export.title')}
      subtitle={tSync('export.subtitle')}
      color="permission"
      onCancel={handleCancel}
      inputGuide={renderInputGuide}
      isCancelActive={!showFilenameInput}
    >
      {!showFilenameInput ? (
        <Select options={options} onChange={handleSelectOption} onCancel={handleCancel} />
      ) : (
        <Box flexDirection="column">
          <Text>{tSync('export.enterFilename')}</Text>
          <Box flexDirection="row" gap={1} marginTop={1}>
            <Text>&gt;</Text>
            <TextInput
              value={filename}
              onChange={setFilename}
              onSubmit={handleFilenameSubmit}
              focus={true}
              showCursor={true}
              columns={columns}
              cursorOffset={cursorOffset}
              onChangeCursorOffset={setCursorOffset}
            />
          </Box>
        </Box>
      )}
    </Dialog>
  )
}
