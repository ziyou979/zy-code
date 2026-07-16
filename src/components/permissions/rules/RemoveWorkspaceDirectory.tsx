import { tSync } from 'src/i18n/index.js'
import { Select } from '../../CustomSelect/select.js'
import { Box, Text } from '../../../ink/index.js'
import type { ToolPermissionContext } from '../../../tools/Tool.js'
import { applyPermissionUpdate } from '../../../services/permissions/permissionUpdate.js'
import { Dialog } from '../../design-system/Dialog.js'

type Props = {
  directoryPath: string
  onRemove: () => void
  onCancel: () => void
  permissionContext: ToolPermissionContext
  setPermissionContext: (context: ToolPermissionContext) => void
}
export function RemoveWorkspaceDirectory({
  directoryPath,
  onRemove,
  onCancel,
  permissionContext,
  setPermissionContext,
}: Props) {
  const handleRemove = () => {
    const updatedContext = applyPermissionUpdate(permissionContext, {
      type: 'removeDirectories',
      directories: [directoryPath],
      destination: 'session',
    })
    setPermissionContext(updatedContext)
    onRemove()
  }
  const handleSelect = (value: string) => {
    if (value === 'yes') {
      handleRemove()
    } else {
      onCancel()
    }
  }
  return (
    <Dialog
      title={tSync('permissionRules.removeDirectoryFromWorkspace')}
      onCancel={onCancel}
      color="error"
    >
      {
        <Box marginX={2} flexDirection="column">
          <Text bold={true}>{directoryPath}</Text>
        </Box>
      }
      {<Text>{tSync('permissionRules.directoryRemovedWarning')}</Text>}
      {
        <Select
          onChange={handleSelect}
          onCancel={onCancel}
          options={[
            {
              label: tSync('permission.yes'),
              value: 'yes',
            },
            {
              label: tSync('permission.no'),
              value: 'no',
            },
          ]}
        />
      }
    </Dialog>
  )
}
