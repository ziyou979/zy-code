import React from 'react'
import { tSync } from 'src/i18n/index.js'
import { logEvent } from 'src/services/analytics/index.js'
import { Box, Link, Text } from '../ink.js'
import type { ExternalAgentsMdInclude } from '../utils/agentsMd.js'
import { saveCurrentProjectConfig } from '../utils/config.js'
import { Select } from './CustomSelect/index.js'
import { Dialog } from './design-system/Dialog.js'

type Props = {
  onDone(): void
  isStandaloneDialog?: boolean
  externalIncludes?: ExternalAgentsMdInclude[]
}
export function agentsMdExternalIncludesDialog({
  onDone,
  isStandaloneDialog,
  externalIncludes,
}: Props) {
  React.useEffect(() => {
    logEvent('zy_agents_md_includes_dialog_shown', {})
  }, [])
  const handleSelection = (value) => {
    if (value === 'no') {
      logEvent('zy_agents_md_external_includes_dialog_declined', {})
      saveCurrentProjectConfig((current) => ({
        ...current,
        hasAgentsMdExternalIncludesApproved: false,
        hasAgentsMdExternalIncludesWarningShown: true,
      }))
    } else {
      logEvent('zy_agents_md_external_includes_dialog_accepted', {})
      saveCurrentProjectConfig((current_0) => ({
        ...current_0,
        hasAgentsMdExternalIncludesApproved: true,
        hasAgentsMdExternalIncludesWarningShown: true,
      }))
    }
    onDone()
  }
  const handleEscape = () => {
    handleSelection('no')
  }
  return (
    <Dialog
      title={tSync('agentsMd.allowExternalTitle')}
      color="warning"
      onCancel={handleEscape}
      hideBorder={!isStandaloneDialog}
      hideInputGuide={!isStandaloneDialog}
    >
      {<Text>{tSync('agentsMd.importsOutsideWarning')}</Text>}
      {externalIncludes && externalIncludes.length > 0 && (
        <Box flexDirection="column">
          <Text dimColor={true}>{tSync('agentsMd.externalImports')}</Text>
          {externalIncludes.map((include, i) => (
            <Text key={i} dimColor={true}>
              {'  '}
              {include.path}
            </Text>
          ))}
        </Box>
      )}
      {
        <Text dimColor={true}>
          {tSync('agentsMd.securityWarning')} <Link url="https://code.zy.com/docs/en/security" />{' '}
        </Text>
      }
      {
        <Select
          options={[
            {
              label: tSync('agentsMd.yesAllow'),
              value: 'yes',
            },
            {
              label: tSync('agentsMd.noDisable'),
              value: 'no',
            },
          ]}
          onChange={(value_0) => handleSelection(value_0 as 'yes' | 'no')}
        />
      }
    </Dialog>
  )
}
