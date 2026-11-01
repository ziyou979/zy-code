import React from 'react'
import { randomUUID } from 'node:crypto'
import { getSessionId } from '../bootstrap/runtime/runtimeContext.js'
import { useSetAppState } from '../state/AppState.js'
import { tSync } from '../i18n/index.js'
import { logEvent } from '../services/analytics/index.js'
import { Box, Link, Text } from '../ink/index.js'
import {
  getClassifierModel,
  getTwoStageMode,
  isTwoStageClassifierEnabled,
} from '../services/permissions/classifierTranscript.js'
import {
  getAutoModeModelAuthorization,
  getAutoModeQualificationFingerprint,
  saveDirectAutoModeAuthorization,
} from '../services/permissions/autoModeQualification.js'
import {
  AUTO_MODE_EVALUATION_CASES,
  AUTO_MODE_EVALUATION_REPEATS,
} from '../services/permissions/autoModeEvaluation.js'
import {
  startAutoModeEvaluationTask,
  type AutoModeEvaluationTaskContext,
} from '../services/permissions/autoModeEvaluationTask.js'
import { updateSettingsForSource } from '../services/settings/settings.js'
import { Select } from './CustomSelect/index.js'
import { Dialog } from './design-system/Dialog.js'

export const getAutoModeDescription = () => tSync('autoMode.description')

type Props = {
  onAccept(): void
  onDecline(): void
  declineExits?: boolean
  getEvaluationContext?(): AutoModeEvaluationTaskContext
}

export function AutoModeOptInDialog({
  onAccept,
  onDecline,
  declineExits,
  getEvaluationContext,
}: Props) {
  const [model] = React.useState(getClassifierModel)
  const [fingerprint] = React.useState(() => getAutoModeQualificationFingerprint(model))
  const setAppState = useSetAppState()
  const [confirmEvaluation, setConfirmEvaluation] = React.useState(false)
  const [error, setError] = React.useState(false)
  const authorization = getAutoModeModelAuthorization(model)
  const unverified = authorization === 'unverified'
  const total = AUTO_MODE_EVALUATION_CASES.length * AUTO_MODE_EVALUATION_REPEATS
  const maxRequests =
    total * (isTwoStageClassifierEnabled() && getTwoStageMode() === 'both' ? 2 : 1)
  React.useEffect(() => {
    logEvent('zy_auto_mode_opt_in_dialog_shown', {})
  }, [])
  const accept = (mode: 'temporary' | 'always' | 'default') => {
    try {
      if (
        getClassifierModel() !== model ||
        getAutoModeQualificationFingerprint(model) !== fingerprint ||
        getAutoModeModelAuthorization(model) === 'disabled'
      ) {
        throw new Error('Auto mode context changed')
      }
      if (mode === 'temporary') {
        setAppState((previous) => ({
          ...previous,
          autoModeSessionGrant: { id: randomUUID(), sessionId: getSessionId(), model, fingerprint },
        }))
        onAccept()
        return
      }
      if (unverified) {
        const grant = saveDirectAutoModeAuthorization(model, fingerprint)
        if (grant.error) {
          throw grant.error
        }
      }
      const saved = updateSettingsForSource('userSettings', {
        skipAutoPermissionPrompt: true,
        ...(mode === 'default' ? { permissions: { defaultMode: 'auto' as const } } : {}),
      })
      if (saved.error) {
        throw saved.error
      }
      logEvent('zy_auto_mode_opt_in_dialog_accept', {})
      onAccept()
    } catch {
      if (mode === 'temporary') {
        // 门控或模式转换失败时撤销尚未启用的授权，不留待后续入口误用。
        setAppState((previous) => ({ ...previous, autoModeSessionGrant: undefined }))
      }
      setError(true)
    }
  }
  return (
    <Dialog title={tSync('autoMode.title')} color="warning" onCancel={onDecline}>
      <Box flexDirection="column" gap={1}>
        <Text>{getAutoModeDescription()}</Text>
        {unverified && <Text>{tSync('autoModeEvaluation.firstUse', { model })}</Text>}
        {unverified && !declineExits && (
          <Text dimColor>{tSync('autoModeEvaluation.temporaryHint')}</Text>
        )}
        {confirmEvaluation && (
          <Text color="warning">
            {tSync('autoModeEvaluation.confirmHint', {
              count: String(total),
              requests:
                maxRequests === total ? String(total) : `${String(total)}–${String(maxRequests)}`,
            })}
          </Text>
        )}
        {error && <Text color="error">{tSync('autoModeEvaluation.error')}</Text>}
        <Link url="https://code.zy.com/docs/en/security" />
      </Box>
      <Select
        key={String(confirmEvaluation)}
        defaultFocusValue="decline"
        options={
          confirmEvaluation
            ? [
                { label: tSync('autoModeEvaluation.keepManual'), value: 'decline' },
                { label: tSync('autoModeEvaluation.confirmStart'), value: 'evaluate-confirmed' },
              ]
            : [
                {
                  label: declineExits
                    ? tSync('autoMode.declineExit')
                    : tSync('autoMode.declineBack'),
                  value: 'decline',
                },
                ...(unverified && !declineExits
                  ? [
                      {
                        label: tSync('autoModeEvaluation.enableTemporary'),
                        value: 'accept-temporary',
                      },
                    ]
                  : []),
                {
                  label: tSync(unverified ? 'autoModeEvaluation.enableDirect' : 'autoMode.accept'),
                  value: 'accept',
                },
                ...(getEvaluationContext
                  ? [{ label: tSync('autoModeEvaluation.verifyFirst'), value: 'evaluate' }]
                  : []),
                ...(!unverified
                  ? [{ label: tSync('autoMode.acceptDefault'), value: 'accept-default' }]
                  : []),
              ]
        }
        onChange={(value) => {
          if (value === 'evaluate') {
            setConfirmEvaluation(true)
            setError(false)
          } else if (value === 'evaluate-confirmed') {
            try {
              if (!getEvaluationContext || getClassifierModel() !== model) {
                throw new Error('Evaluation context changed')
              }
              const result = startAutoModeEvaluationTask(
                getEvaluationContext(),
                model,
                getAutoModeQualificationFingerprint(model),
              )
              if (result.error) {
                throw result.error
              }
              onDecline()
            } catch {
              setError(true)
            }
          } else if (
            value === 'accept' ||
            value === 'accept-default' ||
            value === 'accept-temporary'
          ) {
            accept(
              value === 'accept-temporary'
                ? 'temporary'
                : value === 'accept-default'
                  ? 'default'
                  : 'always',
            )
          } else if (confirmEvaluation) {
            setConfirmEvaluation(false)
          } else {
            onDecline()
          }
        }}
        onCancel={() => {
          if (confirmEvaluation) {
            setConfirmEvaluation(false)
          } else {
            onDecline()
          }
        }}
      />
    </Dialog>
  )
}
