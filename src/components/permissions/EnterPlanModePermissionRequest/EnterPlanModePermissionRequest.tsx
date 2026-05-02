import React from 'react'
import { handlePlanModeTransition } from '../../../bootstrap/state.js'
import { tSync } from '../../../i18n/index.js'
import { Box, Text } from '../../../ink.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../../services/analytics/index.js'
import { useAppState } from '../../../state/AppState.js'
import { isPlanModeInterviewPhaseEnabled } from '../../../utils/planModeV2.js'
import { Select } from '../../CustomSelect/index.js'
import { PermissionDialog } from '../PermissionDialog.js'
export function EnterPlanModePermissionRequest({ toolUseConfirm, onDone, onReject, workerBadge }) {
  const toolPermissionContextMode = useAppState((s) => s.toolPermissionContext.mode)
  const handleResponse = function handleResponse(value) {
    if (value === 'yes') {
      logEvent('zy_plan_enter', {
        interviewPhaseEnabled: isPlanModeInterviewPhaseEnabled(),
        entryMethod: 'tool' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      })
      handlePlanModeTransition(toolPermissionContextMode, 'plan')
      onDone()
      toolUseConfirm.onAllow({}, [
        {
          type: 'setMode',
          mode: 'plan',
          destination: 'session',
        },
      ])
    } else {
      onDone()
      onReject()
      toolUseConfirm.onReject()
    }
  }
  return (
    <PermissionDialog
      color="planMode"
      title={tSync('planMode.enterTitle')}
      workerBadge={workerBadge}
    >
      {
        <Box flexDirection="column" marginTop={1} paddingX={1}>
          {<Text>{tSync('planMode.wantsEnter')}</Text>}
          {
            <Box marginTop={1} flexDirection="column">
              <Text dimColor={true}>{tSync('planMode.inPlanModeWill')}</Text>
              <Text dimColor={true}>{tSync('planMode.exploreCodebase')}</Text>
              <Text dimColor={true}>{tSync('planMode.identifyPatterns')}</Text>
              <Text dimColor={true}>{tSync('planMode.designStrategy')}</Text>
              <Text dimColor={true}>{tSync('planMode.presentPlan')}</Text>
            </Box>
          }
          {
            <Box marginTop={1}>
              <Text dimColor={true}>{tSync('planMode.noCodeChanges')}</Text>
            </Box>
          }
          <Box marginTop={1}>
            <Select
              options={[
                {
                  label: tSync('planMode.yesEnter'),
                  value: 'yes' as const,
                },
                {
                  label: tSync('planMode.noStartImpl'),
                  value: 'no' as const,
                },
              ]}
              onChange={handleResponse}
              onCancel={() => handleResponse('no')}
            />
          </Box>
        </Box>
      }
    </PermissionDialog>
  )
}
