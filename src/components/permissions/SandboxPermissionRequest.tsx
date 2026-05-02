import * as React from 'react'
import { Box, Text } from 'src/ink.js'
import {
  type NetworkHostPattern,
  shouldAllowManagedSandboxDomainsOnly,
} from 'src/utils/sandbox/sandbox-adapter.js'
import { Select } from '../CustomSelect/select.js'
import { PermissionDialog } from './PermissionDialog.js'
import { tSync } from 'src/i18n/index.js'
export type SandboxPermissionRequestProps = {
  hostPattern: NetworkHostPattern
  onUserResponse: (response: { allow: boolean; persistToSettings: boolean }) => void
}
export function SandboxPermissionRequest({
  hostPattern: t1,
  onUserResponse,
}: SandboxPermissionRequestProps) {
  const { host } = t1
  const onSelect = function onSelect(value) {
    switch (value) {
      case 'yes': {
        onUserResponse({
          allow: true,
          persistToSettings: false,
        })
        break
      }
      case 'yes-dont-ask-again': {
        onUserResponse({
          allow: true,
          persistToSettings: true,
        })
        break
      }
      case 'no': {
        onUserResponse({
          allow: false,
          persistToSettings: false,
        })
      }
    }
  }
  const managedDomainsOnly = shouldAllowManagedSandboxDomainsOnly()
  const options = [
    {
      label: tSync('permission.yes'),
      value: 'yes',
    },
    ...(!managedDomainsOnly
      ? [
          {
            label: <Text>{tSync('permission.yesDontAskAgainDomain', { domain: host })}</Text>,
            value: 'yes-dont-ask-again',
          },
        ]
      : []),
    {
      label: tSync('permission.noAndTell'),
      value: 'no',
    },
  ]
  return (
    <PermissionDialog title={tSync('permissionRules.networkRequestOutsideSandbox')}>
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        {
          <Box>
            {<Text dimColor={true}>{tSync('permissionRules.hostLabel')}</Text>}
            <Text> {host}</Text>
          </Box>
        }
        {
          <Box marginTop={1}>
            <Text>{tSync('permission.allowNetworkConnection')}</Text>
          </Box>
        }
        {
          <Box>
            <Select
              options={options}
              onChange={onSelect}
              onCancel={() => {
                onUserResponse({
                  allow: false,
                  persistToSettings: false,
                })
              }}
            />
          </Box>
        }
      </Box>
    </PermissionDialog>
  )
}
