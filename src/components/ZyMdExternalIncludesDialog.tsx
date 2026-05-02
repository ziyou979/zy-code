import React from 'react'
import { tSync } from 'src/i18n/index.js'
import { logEvent } from 'src/services/analytics/index.js'
import { Box, Link, Text } from '../ink.js'
import type { ExternalzyMdInclude } from '../utils/zymd.js'
import { saveCurrentProjectConfig } from '../utils/config.js'
import { Select } from './CustomSelect/index.js'
import { Dialog } from './design-system/Dialog.js'
type Props = {
  onDone(): void
  isStandaloneDialog?: boolean
  externalIncludes?: ExternalzyMdInclude[]
}
export function zyMdExternalIncludesDialog({
  onDone,
  isStandaloneDialog,
  externalIncludes,
}: Props) {
  React.useEffect(() => {
    logEvent('zy_Zy_md_includes_dialog_shown', {})
  }, [])
  const handleSelection = (value) => {
    if (value === 'no') {
      logEvent('zy_Zy_md_external_includes_dialog_declined', {})
      saveCurrentProjectConfig((current) => ({
        ...current,
        haszyMdExternalIncludesApproved: false,
        haszyMdExternalIncludesWarningShown: true,
      }))
    } else {
      logEvent('zy_Zy_md_external_includes_dialog_accepted', {})
      saveCurrentProjectConfig((current_0) => ({
        ...current_0,
        haszyMdExternalIncludesApproved: true,
        haszyMdExternalIncludesWarningShown: true,
      }))
    }
    onDone()
  }
  const handleEscape = () => {
    handleSelection('no')
  }
  return (
    <Dialog
      title={tSync('zyMd.allowExternalTitle')}
      color="warning"
      onCancel={handleEscape}
      hideBorder={!isStandaloneDialog}
      hideInputGuide={!isStandaloneDialog}
    >
      {<Text>{tSync('zyMd.importsOutsideWarning')}</Text>}
      {externalIncludes && externalIncludes.length > 0 && (
        <Box flexDirection="column">
          <Text dimColor={true}>{tSync('zyMd.externalImports')}</Text>
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
          {tSync('zyMd.securityWarning')} <Link url="https://code.zy.com/docs/en/security" />{' '}
        </Text>
      }
      {
        <Select
          options={[
            {
              label: tSync('zyMd.yesAllow'),
              value: 'yes',
            },
            {
              label: tSync('zyMd.noDisable'),
              value: 'no',
            },
          ]}
          onChange={(value_0) => handleSelection(value_0 as 'yes' | 'no')}
        />
      }
    </Dialog>
  )
}
