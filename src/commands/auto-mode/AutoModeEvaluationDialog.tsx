import { useState } from 'react'
import { Select } from '../../components/CustomSelect/select.js'
import { tSync } from '../../i18n/index.js'
import { Box, Text } from '../../ink/index.js'
import {
  AUTO_MODE_EVALUATION_CASES,
  AUTO_MODE_EVALUATION_REPEATS,
  scoreAutoModeEvaluation,
} from '../../services/permissions/autoModeEvaluation.js'
import {
  cancelAutoModeEvaluationTask,
  startAutoModeEvaluationTask,
} from '../../services/permissions/autoModeEvaluationTask.js'
import {
  getAutoModeModelAuthorization,
  getAutoModeQualification,
  getAutoModeQualificationFingerprint,
} from '../../services/permissions/autoModeQualification.js'
import {
  getClassifierModel,
  getTwoStageMode,
  isTwoStageClassifierEnabled,
} from '../../services/permissions/classifierTranscript.js'
import { resolveModelRequestContext } from '../../services/model/modelRequestContext.js'
import { useAppState } from '../../state/AppState.js'
import type {
  LocalJSXCommandCall,
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../types.js'

function AutoModeEvaluationDialog({
  context,
  onDone,
  requestEvaluation,
}: {
  context: LocalJSXCommandContext
  onDone: LocalJSXCommandOnDone
  requestEvaluation: boolean
}) {
  const [confirming, setConfirming] = useState(requestEvaluation)
  const [error, setError] = useState(false)
  const task = useAppState((state) => state.autoModeEvaluation)
  const running = task?.status === 'running'
  const model = getClassifierModel()
  const report = getAutoModeQualification(model)
  const authorization = getAutoModeModelAuthorization(model)
  const total = AUTO_MODE_EVALUATION_CASES.length * AUTO_MODE_EVALUATION_REPEATS
  const maxRequests =
    total * (isTwoStageClassifierEnabled() && getTwoStageMode() === 'both' ? 2 : 1)
  let connectionId: string | undefined
  try {
    const route = resolveModelRequestContext(model)
    connectionId = route.authProfile ?? route.provider
  } catch {
    // 配置不完整时只展示状态，明确确认后报告配置错误。
  }
  const score = report ? scoreAutoModeEvaluation(report.observations) : undefined
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>{tSync('autoModeEvaluation.title', { model })}</Text>
      <Text>
        {tSync('autoModeEvaluation.connection', {
          connectionId: connectionId ?? tSync('modelCapability.unknown'),
        })}
      </Text>
      <Text dimColor>{tSync('autoModeEvaluation.hint', { count: String(total) })}</Text>
      <Text>
        {tSync(
          authorization === 'verified'
            ? 'autoModeEvaluation.eligible'
            : authorization === 'direct'
              ? 'autoModeEvaluation.directAuthorized'
              : authorization === 'temporary'
                ? 'autoModeEvaluation.temporaryAuthorized'
                : 'autoModeEvaluation.ineligible',
        )}
      </Text>
      {score && (
        <Text>
          {tSync('autoModeEvaluation.score', {
            blocked: String(score.blockedDangerous),
            dangerous: String(score.dangerousTotal),
            allowed: String(score.allowedBenign),
            benign: String(score.benignTotal),
            valid: String(score.validResponses),
            total: String(score.expected),
          })}
        </Text>
      )}
      {error && <Text color="error">{tSync('autoModeEvaluation.error')}</Text>}
      {running && (
        <Text>
          {tSync('autoModeEvaluation.backgroundProgress', {
            model: task.model,
            completed: String(task.completed),
            total: String(task.total),
          })}
        </Text>
      )}
      {confirming && !running && (
        <Text color="warning">
          {tSync('autoModeEvaluation.confirmHint', {
            count: String(total),
            requests:
              maxRequests === total ? String(total) : `${String(total)}–${String(maxRequests)}`,
          })}
        </Text>
      )}
      {(authorization === 'verified' || authorization === 'direct') && (
        <Text dimColor>{tSync('autoModeEvaluation.activationHint')}</Text>
      )}
      <Select
        key={`${String(running)}:${String(confirming)}`}
        defaultFocusValue={confirming && !running ? 'cancel' : 'close'}
        options={
          running
            ? [
                { value: 'close', label: tSync('autoModeEvaluation.continueTask') },
                { value: 'stop', label: tSync('autoModeEvaluation.cancel') },
              ]
            : confirming
              ? [
                  { value: 'cancel', label: tSync('autoModeEvaluation.keepManual') },
                  { value: 'confirm', label: tSync('autoModeEvaluation.confirmStart') },
                ]
              : [
                  { value: 'evaluate', label: tSync('autoModeEvaluation.start') },
                  { value: 'close', label: tSync('autoModeEvaluation.close') },
                ]
        }
        onChange={(value) => {
          if (value === 'evaluate') {
            setError(false)
            setConfirming(true)
          } else if (value === 'confirm') {
            try {
              if (getClassifierModel() !== model) {
                throw new Error('Classifier changed before confirmation')
              }
              const result = startAutoModeEvaluationTask(
                context,
                model,
                getAutoModeQualificationFingerprint(model),
              )
              if (result.error) {
                throw result.error
              }
              onDone(undefined, { display: 'skip' })
            } catch {
              setError(true)
            }
          } else if (value === 'cancel') {
            setConfirming(false)
          } else if (value === 'stop') {
            cancelAutoModeEvaluationTask(context)
          } else {
            onDone(undefined, { display: 'skip' })
          }
        }}
        onCancel={() => {
          if (confirming && !running) {
            setConfirming(false)
          } else {
            onDone(undefined, { display: 'skip' })
          }
        }}
      />
    </Box>
  )
}

export const call: LocalJSXCommandCall = async (onDone, context, args) => (
  <AutoModeEvaluationDialog
    context={context}
    onDone={onDone}
    requestEvaluation={args.trim() === 'evaluate'}
  />
)
