import { tSync } from '../../../i18n/index.js'
import { Box, Text, useTheme } from '../../../ink.js'
import { FallbackPermissionRequest } from '../FallbackPermissionRequest.js'
import { FilePermissionDialog } from '../FilePermissionDialog/FilePermissionDialog.js'
import type { ToolInput } from '../FilePermissionDialog/useFilePermissionDialog.js'
import type { ToolUseConfirm } from '../PermissionRequest.js'

function pathFromToolUse(toolUseConfirm: ToolUseConfirm): string | null {
  const tool = toolUseConfirm.tool
  if ('getPath' in tool && typeof tool.getPath === 'function') {
    try {
      return tool.getPath(toolUseConfirm.input)
    } catch {
      return null
    }
  }
  return null
}
export function FilesystemPermissionRequest({
  toolUseConfirm,
  onDone,
  onReject,
  verbose,
  toolUseContext,
  workerBadge,
}: import('../PermissionRequest.js').PermissionRequestProps) {
  const [theme] = useTheme()
  const path = pathFromToolUse(toolUseConfirm)
  const userFacingName = toolUseConfirm.tool.userFacingName(toolUseConfirm.input as never)
  const isReadOnly = toolUseConfirm.tool.isReadOnly(toolUseConfirm.input)
  const _userFacingReadOrEdit = isReadOnly ? tSync('permission.read') : tSync('permission.edit')
  const title = isReadOnly ? tSync('permission.readFileTitle') : tSync('permission.editFile')
  const parseInput = (input: unknown) => input as ToolInput
  if (!path) {
    return (
      <FallbackPermissionRequest
        toolUseConfirm={toolUseConfirm}
        toolUseContext={toolUseContext}
        onDone={onDone}
        onReject={onReject}
        verbose={verbose}
        workerBadge={workerBadge}
      />
    ) as any
  }
  const renderedToolUseMessage = toolUseConfirm.tool.renderToolUseMessage(
    toolUseConfirm.input as never,
    {
      theme,
      verbose,
    },
  )
  const content = (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Text>
        {userFacingName}({renderedToolUseMessage})
      </Text>
    </Box>
  )
  return (
    <FilePermissionDialog
      toolUseConfirm={toolUseConfirm}
      toolUseContext={toolUseContext}
      onDone={onDone}
      onReject={onReject}
      workerBadge={workerBadge}
      title={title}
      content={content}
      path={path}
      parseInput={parseInput}
      operationType={isReadOnly ? 'read' : 'write'}
      completionType="tool_use_single"
    />
  )
}
