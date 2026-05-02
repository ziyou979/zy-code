import React, { useEffect, useState } from 'react'
import { checkIsGitClean, checkNeedsZyAiLogin } from 'src/utils/background/remote/preconditions.js'
import { gracefulShutdownSync } from 'src/utils/gracefulShutdown.js'
import { Box, Text } from '../ink.js'
import { tSync } from 'src/i18n/index.js'
import { ConsoleOAuthFlow } from './ConsoleOAuthFlow.js'
import { Select } from './CustomSelect/index.js'
import { Dialog } from './design-system/Dialog.js'
import { TeleportStash } from './TeleportStash.js'
export type TeleportLocalErrorType = 'needsLogin' | 'needsGitStash'
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
  const [currentError, setCurrentError] = useState(null)
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
  const handleLoginDialogSelect = (value) => {
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
      let t9
      t9 = <TeleportStash onStashAndContinue={handleStashComplete} onCancel={onCancel} />
      return t9
    }
    case 'needsLogin': {
      if (isLoggingIn) {
        let t9
        t9 = <ConsoleOAuthFlow onDone={handleLoginComplete} mode="login" forceLoginMethod="zyai" />
        return t9
      }
      let t9
      t9 = (
        <Box flexDirection="column">
          <Text dimColor={true}>{tSync('teleport.requiresAccount')}</Text>
          <Text dimColor={true}>{tSync('teleport.subscriptionInfo')}</Text>
        </Box>
      )
      let t10
      t10 = (
        <Dialog title={tSync('teleport.loginTitle')} onCancel={onCancel}>
          {t9}
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
      return t10
    }
  }
}

/**
 * Gets current teleport errors that need to be resolved
 * @returns Set of teleport error types that need to be handled
 */

export async function getTeleportErrors(): Promise<Set<TeleportLocalErrorType>> {
  const errors = new Set<TeleportLocalErrorType>()
  const [needsLogin, isGitClean] = await Promise.all([checkNeedsZyAiLogin(), checkIsGitClean()])
  if (needsLogin) {
    errors.add('needsLogin')
  }
  if (!isGitClean) {
    errors.add('needsGitStash')
  }
  return errors
}
