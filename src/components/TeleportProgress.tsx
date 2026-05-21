import figures from 'figures'
import * as React from 'react'
import { useState } from 'react'
import { tSync } from 'src/i18n/index.js'
import type { Root } from '../ink.js'
import { Box, Text, useAnimationFrame } from '../ink.js'
import { AppStateProvider } from '../state/AppState.js'
import {
  checkOutTeleportedSessionBranch,
  processMessagesForTeleportResume,
  type TeleportProgressStep,
  type TeleportResult,
  teleportResumeCodeSession,
} from '../utils/teleport.js'

type Props = {
  currentStep: TeleportProgressStep
  sessionId?: string
}
const SPINNER_FRAMES = ['◐', '◓', '◑', '◒']
const STEP_KEYS: {
  key: TeleportProgressStep
  i18nKey: string
}[] = [
  {
    key: 'validating',
    i18nKey: 'teleport.validatingSession',
  },
  {
    key: 'fetching_logs',
    i18nKey: 'teleport.fetchingSessionLogs',
  },
  {
    key: 'fetching_branch',
    i18nKey: 'teleport.gettingBranchInfo',
  },
  {
    key: 'checking_out',
    i18nKey: 'teleport.checkingOutBranch',
  },
]
export function TeleportProgress({ currentStep, sessionId }: Props) {
  const [ref, time] = useAnimationFrame(100)
  const frame = Math.floor(time / 100) % SPINNER_FRAMES.length
  const currentStepIndex = STEP_KEYS.findIndex((s) => s.key === currentStep)
  const progressSteps = STEP_KEYS.map((step, index) => {
    const isComplete = index < currentStepIndex
    const isCurrent = index === currentStepIndex
    const isPending = index > currentStepIndex
    let icon
    let color
    if (isComplete) {
      icon = figures.tick
      color = 'green'
    } else {
      if (isCurrent) {
        icon = SPINNER_FRAMES[frame]
        color = 'zy'
      } else {
        icon = figures.circle
        color = undefined
      }
    }
    return (
      <Box key={step.key} flexDirection="row">
        <Box width={2}>
          <Text color={color as never} dimColor={isPending}>
            {icon}
          </Text>
        </Box>
        <Text dimColor={isPending} bold={isCurrent}>
          {tSync(step.i18nKey as any)}
        </Text>
      </Box>
    )
  })
  return (
    <Box ref={ref} flexDirection="column" paddingX={1} paddingY={1}>
      {
        <Box marginBottom={1}>
          <Text bold={true} color="zy">
            {SPINNER_FRAMES[frame]} {tSync('teleport.teleportingSession')}
          </Text>
        </Box>
      }
      {sessionId && (
        <Box marginBottom={1}>
          <Text dimColor={true}>{sessionId}</Text>
        </Box>
      )}
      {
        <Box flexDirection="column" marginLeft={2}>
          {progressSteps}
        </Box>
      }
    </Box>
  )
}

/**
 * Teleports to a remote session with progress UI rendered into the existing root.
 * Fetches the session, checks out the branch, and returns the result.
 */
export async function teleportWithProgress(root: Root, sessionId: string): Promise<TeleportResult> {
  // Capture the setState function from the rendered component
  let setStep: (step: TeleportProgressStep) => void = () => {}
  function TeleportProgressWrapper(): React.ReactNode {
    const [step, _setStep] = useState<TeleportProgressStep>('validating')
    setStep = _setStep
    return <TeleportProgress currentStep={step} sessionId={sessionId} />
  }
  root.render(
    <AppStateProvider>
      <TeleportProgressWrapper />
    </AppStateProvider>,
  )
  const result = await teleportResumeCodeSession(sessionId, setStep)
  setStep('checking_out')
  const { branchName, branchError } = await checkOutTeleportedSessionBranch(result.branch)
  return {
    messages: processMessagesForTeleportResume(result.log, branchError),
    branchName,
  }
}
