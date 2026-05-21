import figures from 'figures'
import React, { useEffect, useState } from 'react'
import { tSync } from 'src/i18n/index.js'
import { Box, Text } from '../ink.js'
import { logForDebugging } from '../utils/debug.js'
import type { GitFileStatus } from '../utils/git.js'
import { getFileStatus, stashToCleanState } from '../utils/git.js'
import { Select } from './CustomSelect/index.js'
import { Dialog } from './design-system/Dialog.js'
import { Spinner } from './Spinner.js'

type TeleportStashProps = {
  onStashAndContinue: () => void
  onCancel: () => void
}
export function TeleportStash({
  onStashAndContinue,
  onCancel,
}: TeleportStashProps): React.ReactNode {
  const [gitFileStatus, setGitFileStatus] = useState<GitFileStatus | null>(null)
  const changedFiles =
    gitFileStatus !== null ? [...gitFileStatus.tracked, ...gitFileStatus.untracked] : []
  const [loading, setLoading] = useState(true)
  const [stashing, setStashing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 挂载时加载更改的文件
  useEffect(() => {
    const loadChangedFiles = async () => {
      try {
        const fileStatus = await getFileStatus()
        setGitFileStatus(fileStatus)
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err)
        logForDebugging(`Error getting changed files: ${errorMessage}`, {
          level: 'error',
        })
        setError(tSync('teleport.getGitStatusFailed'))
      } finally {
        setLoading(false)
      }
    }
    void loadChangedFiles()
  }, [])
  const handleStash = async () => {
    setStashing(true)
    try {
      logForDebugging('Stashing changes before teleport...')
      const success = await stashToCleanState('Teleport auto-stash')
      if (success) {
        logForDebugging('Successfully stashed changes')
        onStashAndContinue()
      } else {
        setError(tSync('teleport.stashFailed'))
      }
    } catch (err_0) {
      const errorMessage_0 = err_0 instanceof Error ? err_0.message : String(err_0)
      logForDebugging(`Error stashing changes: ${errorMessage_0}`, {
        level: 'error',
      })
      setError(tSync('teleport.stashFailed'))
    } finally {
      setStashing(false)
    }
  }
  const handleSelectChange = (value: string) => {
    if (value === 'stash') {
      void handleStash()
    } else {
      onCancel()
    }
  }
  if (loading) {
    return (
      <Box flexDirection="column" padding={1}>
        <Box marginBottom={1}>
          <Spinner />
          <Text>
            {' '}
            {tSync('teleport.checkingGitStatus')}
            {figures.ellipsis}
          </Text>
        </Box>
      </Box>
    )
  }
  if (error) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color="error">
          {tSync('teleport.errorPrefix', { error })}
        </Text>
        <Box marginTop={1}>
          <Text dimColor>{tSync('teleport.pressEscapeToCancel')}</Text>
        </Box>
      </Box>
    )
  }
  const showFileCount = changedFiles.length > 8
  return (
    <Dialog title={tSync('teleport.workingDirHasChanges')} onCancel={onCancel}>
      <Text>{tSync('teleport.willSwitchBranches')}</Text>

      <Box flexDirection="column" paddingLeft={2}>
        {changedFiles.length > 0 ? (
          showFileCount ? (
            <Text>{tSync('teleport.filesChanged', { count: changedFiles.length })}</Text>
          ) : (
            changedFiles.map((file: string, index: number) => <Text key={index}>{file}</Text>)
          )
        ) : (
          <Text dimColor>{tSync('teleport.noChangesDetected')}</Text>
        )}
      </Box>

      <Text>{tSync('teleport.stashAndContinue')}</Text>

      {stashing ? (
        <Box>
          <Spinner />
          <Text> {tSync('teleport.stashingChanges')}</Text>
        </Box>
      ) : (
        <Select
          options={[
            {
              label: tSync('teleport.stashChangesAndContinue'),
              value: 'stash',
            },
            {
              label: tSync('teleport.exit'),
              value: 'exit',
            },
          ]}
          onChange={handleSelectChange}
        />
      )}
    </Dialog>
  )
}
