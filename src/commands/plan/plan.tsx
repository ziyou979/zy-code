import * as React from 'react'
import { handlePlanModeTransition } from 'src/bootstrap/runtime/runtimeContext.js'
import type { LocalJSXCommandContext } from '../../commands/index.js'
import { Box, Text } from '../../ink/index.js'
import type { LocalJSXCommandOnDone } from '../types.js'
import { getExternalEditor } from '../../terminal-ui/editor.js'
import { toIDEDisplayName } from '../../services/ide/ide.js'
import { applyPermissionUpdate } from '../../services/permissions/permissionUpdate.js'
import { prepareContextForPlanMode } from '../../services/permissions/permissionSetup.js'
import { getPlan, getPlanFilePath } from '../../services/plans/plans.js'
import { editFileInEditor } from '../../terminal-ui/promptEditor.js'
import { renderToString } from '../../components/Runtime/StaticRender.js'

function PlanDisplay({
  planContent,
  planPath,
  editorName,
}: {
  planContent: string
  planPath: string
  editorName?: string
}) {
  return (
    <Box flexDirection="column">
      {<Text bold={true}>Current Plan</Text>}
      {<Text dimColor={true}>{planPath}</Text>}
      {
        <Box marginTop={1}>
          <Text>{planContent}</Text>
        </Box>
      }
      {editorName && (
        <Box marginTop={1}>
          <Text dimColor={true}>"/plan open"</Text>
          <Text dimColor={true}> to edit this plan in </Text>
          <Text bold={true} dimColor={true}>
            {editorName}
          </Text>
        </Box>
      )}
    </Box>
  )
}
export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args: string,
): Promise<React.ReactNode> {
  const { getAppState, setAppState } = context
  const appState = getAppState()
  const currentMode = appState.toolPermissionContext.mode

  // If not in plan mode, enable it
  if (currentMode !== 'plan') {
    handlePlanModeTransition(currentMode, 'plan')
    setAppState((prev) => ({
      ...prev,
      toolPermissionContext: applyPermissionUpdate(
        prepareContextForPlanMode(prev.toolPermissionContext),
        {
          type: 'setMode',
          mode: 'plan',
          destination: 'session',
        },
      ),
    }))
    const description = args.trim()
    if (description && description !== 'open') {
      onDone('Enabled plan mode', {
        shouldQuery: true,
      })
    } else {
      onDone('Enabled plan mode')
    }
    return null
  }

  // Already in plan mode - show the current plan
  const planContent = getPlan()
  const planPath = getPlanFilePath()
  if (!planContent) {
    onDone('Already in plan mode. No plan written yet.')
    return null
  }

  // If user typed "/plan open", open in editor
  const argList = args.trim().split(/\s+/)
  if (argList[0] === 'open') {
    const result = await editFileInEditor(planPath)
    if (result.error) {
      onDone(`Failed to open plan in editor: ${result.error}`)
    } else {
      onDone(`Opened plan in editor: ${planPath}`)
    }
    return null
  }
  const editor = getExternalEditor()
  const editorName = editor ? toIDEDisplayName(editor) : undefined
  const display = (
    <PlanDisplay planContent={planContent} planPath={planPath} editorName={editorName} />
  )

  // Render to string and pass to onDone like local commands do
  const output = await renderToString(display)
  onDone(output)
  return null
}
