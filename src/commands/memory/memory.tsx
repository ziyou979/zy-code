import { mkdir, writeFile } from 'node:fs/promises'
import * as React from 'react'
import type { CommandResultDisplay } from '../../commands/index.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { MemoryFileSelector } from '../../components/memory/MemoryFileSelector.js'
import { getRelativeMemoryPath } from '../../components/memory/MemoryUpdateNotification.js'
import { tSync } from '../../i18n/index.js'
import { Box, Text } from '../../ink/index.js'
import type { LocalJSXCommandCall } from '../types.js'
import { clearMemoryFileCaches, getMemoryFiles } from '../../utils/agentsMd.js'
import { getZyConfigHomeDir } from '../../utils/envUtils.js'
import { getErrnoCode } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import { editFileInEditor } from '../../terminal-ui/promptEditor.js'

function MemoryCommand({
  onDone,
}: {
  onDone: (
    result?: string,
    options?: {
      display?: CommandResultDisplay
    },
  ) => void
}): React.ReactNode {
  const handleSelectMemoryFile = async (memoryPath: string) => {
    try {
      // Create zy directory if it doesn't exist (idempotent with recursive)
      if (memoryPath.includes(getZyConfigHomeDir())) {
        await mkdir(getZyConfigHomeDir(), {
          recursive: true,
        })
      }

      // Create file if it doesn't exist (wx flag fails if file exists,
      // which we catch to preserve existing content)
      try {
        await writeFile(memoryPath, '', {
          encoding: 'utf8',
          flag: 'wx',
        })
      } catch (e: unknown) {
        if (getErrnoCode(e) !== 'EEXIST') {
          throw e
        }
      }
      await editFileInEditor(memoryPath)

      // Determine which environment variable controls the editor
      let editorSource = 'default'
      let editorValue = ''
      if (process.env.VISUAL) {
        editorSource = '$VISUAL'
        editorValue = process.env.VISUAL
      } else if (process.env.EDITOR) {
        editorSource = '$EDITOR'
        editorValue = process.env.EDITOR
      }
      const editorInfo =
        editorSource !== 'default' ? tSync('memory.usingEditor', { editorSource, editorValue }) : ''
      const editorHint = editorInfo
        ? `> ${tSync('memory.usingEditorHint', { editorSource, editorValue })}`
        : `> ${tSync('memory.editorHint')}`
      onDone(
        `${tSync('memory.openedAt', { path: getRelativeMemoryPath(memoryPath) })}\n\n${editorHint}`,
        {
          display: 'system',
        },
      )
    } catch (error) {
      logError(error)
      onDone(tSync('memory.openError', { error: String(error) }))
    }
  }
  const handleCancel = () => {
    onDone(tSync('memory.cancelled'), {
      display: 'system',
    })
  }
  return (
    <Dialog title={tSync('memory.title')} onCancel={handleCancel} color="remember">
      <Box flexDirection="column">
        <React.Suspense fallback={null}>
          <MemoryFileSelector onSelect={handleSelectMemoryFile} onCancel={handleCancel} />
        </React.Suspense>

        <Box marginTop={1}>
          <Text dimColor>
            {tSync('memory.learnMore', { link: 'https://code.zy.com/docs/en/memory' })}
          </Text>
        </Box>
      </Box>
    </Dialog>
  )
}
export const call: LocalJSXCommandCall = async (onDone) => {
  // Clear + prime before rendering — Suspense handles the unprimed case,
  // but awaiting here avoids a fallback flash on initial open.
  clearMemoryFileCaches()
  await getMemoryFiles()
  return <MemoryCommand onDone={onDone} />
}
