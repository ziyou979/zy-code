import React from 'react';
import { Box, Text, useTheme } from '../../../ink.js';
import { FallbackPermissionRequest } from '../FallbackPermissionRequest.js';
import { FilePermissionDialog } from '../FilePermissionDialog/FilePermissionDialog.js';
import type { ToolInput } from '../FilePermissionDialog/useFilePermissionDialog.js';
import type { PermissionRequestProps, ToolUseConfirm } from '../PermissionRequest.js';
function pathFromToolUse(toolUseConfirm: ToolUseConfirm): string | null {
  const tool = toolUseConfirm.tool;
  if ('getPath' in tool && typeof tool.getPath === 'function') {
    try {
      return tool.getPath(toolUseConfirm.input);
    } catch {
      return null;
    }
  }
  return null;
}
export function FilesystemPermissionRequest({
  toolUseConfirm,
  onDone,
  onReject,
  verbose,
  toolUseContext,
  workerBadge
}) {
  const [theme] = useTheme();
  const path = pathFromToolUse(toolUseConfirm);
  const userFacingName = toolUseConfirm.tool.userFacingName(toolUseConfirm.input as never);
  const isReadOnly = toolUseConfirm.tool.isReadOnly(toolUseConfirm.input);
  const userFacingReadOrEdit = isReadOnly ? "Read" : "Edit";
  const title = `${userFacingReadOrEdit} file`;
  const parseInput = input => input as ToolInput;
  if (!path) {
    return <FallbackPermissionRequest toolUseConfirm={toolUseConfirm} toolUseContext={toolUseContext} onDone={onDone} onReject={onReject} verbose={verbose} workerBadge={workerBadge} />;
  }
  const t3 = toolUseConfirm.tool.renderToolUseMessage(toolUseConfirm.input as never, {
    theme,
    verbose
  });
  const content = <Box flexDirection="column" paddingX={2} paddingY={1}><Text>{userFacingName}({t3})</Text></Box>;
  return <FilePermissionDialog toolUseConfirm={toolUseConfirm} toolUseContext={toolUseContext} onDone={onDone} onReject={onReject} workerBadge={workerBadge} title={title} content={content} path={path} parseInput={parseInput} operationType={isReadOnly ? "read" : "write"} completionType="tool_use_single" />;
}
