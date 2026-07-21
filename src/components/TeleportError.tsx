import { useEffect, useState } from 'react'
import { tSync } from 'src/i18n/index.js'
import {
  getTeleportErrors,
  type TeleportLocalErrorType,
} from 'src/services/teleport/prerequisites.js'
import { gracefulShutdownSync } from 'src/bootstrap/lifecycle/gracefulShutdown.js'
import { Box, Text } from '../ink/index.js'
import { ConsoleOAuthFlow } from './ConsoleOAuthFlow.js'
import { Select } from './CustomSelect/index.js'
import { Dialog } from './design-system/Dialog.js'
import { TeleportStash } from './TeleportStash.js'
export type { TeleportLocalErrorType }
type TeleportErrorProps = {
  onComplete: () => void
  errorsToIgnore?: ReadonlySet<TeleportLocalErrorType>
}

// Module-level sentinel so the default parameter has stable identity.
// Previously `= new Set()` created a fresh Set every render, which put
// a new object in checkErrors' deps and caused the mount effect to
// re-fire on every render.
const EMPTY_ERRORS_TO_IGNORE: ReadonlySet<TeleportLocalErrorType> = new Set()
export function TeleportError({
  onComplete,
  errorsToIgnore = EMPTY_ERRORS_TO_IGNORE,
}: TeleportErrorProps) {
  const [currentError, setCurrentError] = useState<string | null>(null)
  const [isLoggingIn, setIsLoggingIn] = useState(false)
  const checkErrors = async () => {
    const currentErrors = await getTeleportErrors()
    const filteredErrors = new Set(
      Array.from(currentErrors).filter((error) => !errorsToIgnore.has(error)),
    )
    if (filteredErrors.size === 0) {
      onComplete()
      return
    }
    if (filteredErrors.has('needsLogin')) {
      setCurrentError('needsLogin')
    } else {
      if (filteredErrors.has('needsGitStash')) {
        setCurrentError('needsGitStash')
      }
    }
  }
  useEffect(() => {
    checkErrors()
  }, [checkErrors])
  const onCancel = () => {
    gracefulShutdownSync(0)
  }
  const handleLoginComplete = () => {
    setIsLoggingIn(false)
    checkErrors()
  }
  const handleLoginWithZyAI = () => {
    setIsLoggingIn(true)
  }
  const handleLoginDialogSelect = (value: string) => {
    if (value === 'login') {
      handleLoginWithZyAI()
    } else {
      onCancel()
    }
  }
  const handleStashComplete = () => {
    checkErrors()
  }
  if (!currentError) {
    return null
  }
  switch (currentError) {
    case 'needsGitStash': {
      let stashDialogContent
      stashDialogContent = (
        <TeleportStash onStashAndContinue={handleStashComplete} onCancel={onCancel} />
      )
      return stashDialogContent
    }
    case 'needsLogin': {
      if (isLoggingIn) {
        let loginFlowContent
        loginFlowContent = <ConsoleOAuthFlow onDone={handleLoginComplete} />
        return loginFlowContent
      }
      let dialogContent
      dialogContent = (
        <Box flexDirection="column">
          <Text dimColor={true}>{tSync('teleport.requiresAccount')}</Text>
          <Text dimColor={true}>{tSync('teleport.subscriptionInfo')}</Text>
        </Box>
      )
      let loginDialog
      loginDialog = (
        <Dialog title={tSync('teleport.loginTitle')} onCancel={onCancel}>
          {dialogContent}
          <Select
            options={[
              {
                label: tSync('teleport.loginWithZy'),
                value: 'login',
              },
              {
                label: tSync('teleport.exit'),
                value: 'exit',
              },
            ]}
            onChange={handleLoginDialogSelect}
          />
        </Dialog>
      )
      return loginDialog
    }
  }
}
