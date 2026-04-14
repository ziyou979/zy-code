import * as React from 'react';
import { Select } from '../../../components/CustomSelect/select.js';
import { Box, Text } from '../../../ink.js';
import type { ToolPermissionContext } from '../../../Tool.js';
import { applyPermissionUpdate } from '../../../utils/permissions/PermissionUpdate.js';
import { Dialog } from '../../design-system/Dialog.js';
import { tSync } from 'src/i18n/index.js';
type Props = {
  directoryPath: string;
  onRemove: () => void;
  onCancel: () => void;
  permissionContext: ToolPermissionContext;
  setPermissionContext: (context: ToolPermissionContext) => void;
};
export function RemoveWorkspaceDirectory({
  directoryPath,
  onRemove,
  onCancel,
  permissionContext,
  setPermissionContext
}: Props) {
  const handleRemove = () => {
    const updatedContext = applyPermissionUpdate(permissionContext, {
      type: "removeDirectories",
      directories: [directoryPath],
      destination: "session"
    });
    setPermissionContext(updatedContext);
    onRemove();
  };
  const handleSelect = value => {
    if (value === "yes") {
      handleRemove();
    } else {
      onCancel();
    }
  };
  return <Dialog title="Remove directory from workspace?" onCancel={onCancel} color="error">{<Box marginX={2} flexDirection="column"><Text bold={true}>{directoryPath}</Text></Box>}{<Text>ZY Code will no longer have access to files in this directory.</Text>}{<Select onChange={handleSelect} onCancel={onCancel} options={[{
      label: tSync('permission.yes'),
      value: "yes"
    }, {
      label: tSync('permission.no'),
      value: "no"
    }]} />}</Dialog>;
}
