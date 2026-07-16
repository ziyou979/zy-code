import { useState } from 'react'
import { tSync } from 'src/i18n/index.js'
import { Box, Text } from '../ink/index.js'
import { getDisplayPath } from '../utils/file.js'
import { removePathFromRepo, validateRepoAtPath } from '../utils/githubRepoPathMapping.js'
import { Select } from './CustomSelect/index.js'
import { Dialog } from './design-system/Dialog.js'
import { Spinner } from './Spinner.js'

type Props = {
  targetRepo: string
  initialPaths: string[]
  onSelectPath: (path: string) => void
  onCancel: () => void
}
export function TeleportRepoMismatchDialog({
  targetRepo,
  initialPaths,
  onSelectPath,
  onCancel,
}: Props) {
  const [availablePaths, setAvailablePaths] = useState(initialPaths)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [validating, setValidating] = useState(false)
  const handleChange = async (value: string) => {
    if (value === 'cancel') {
      onCancel()
      return
    }
    setValidating(true)
    setErrorMessage(null)
    const isValid = await validateRepoAtPath(value, targetRepo)
    if (isValid) {
      onSelectPath(value)
      return
    }
    removePathFromRepo(targetRepo, value)
    const updatedPaths = availablePaths.filter((p) => p !== value)
    setAvailablePaths(updatedPaths)
    setValidating(false)
    setErrorMessage(tSync('teleport.pathNoLongerValid', { path: getDisplayPath(value) }))
  }
  const options = [
    ...availablePaths.map((path) => ({
      label: <Text>{tSync('teleport.usePath', { path: getDisplayPath(path) })}</Text>,
      value: path,
    })),
    {
      label: tSync('teleport.cancel'),
      value: 'cancel',
    },
  ]
  return (
    <Dialog title={tSync('teleport.repoMismatchTitle')} onCancel={onCancel} color="background">
      {availablePaths.length > 0 ? (
        <>
          <Box flexDirection="column" gap={1}>
            {errorMessage && <Text color="error">{errorMessage}</Text>}
            <Text>{tSync('teleport.openInRepo', { repo: targetRepo })}</Text>
          </Box>
          {validating ? (
            <Box>
              <Spinner />
              <Text> {tSync('teleport.validatingRepo')}</Text>
            </Box>
          ) : (
            <Select options={options} onChange={(value_0: string) => void handleChange(value_0)} />
          )}
        </>
      ) : (
        <Box flexDirection="column" gap={1}>
          {errorMessage && <Text color="error">{errorMessage}</Text>}
          <Text dimColor={true}>{tSync('teleport.runFromCheckout', { repo: targetRepo })}</Text>
        </Box>
      )}
    </Dialog>
  )
}
