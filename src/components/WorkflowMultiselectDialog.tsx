import React, { useState } from 'react'
import type { Workflow } from '../commands/install-github-app/types.js'
import type { ExitState } from '../hooks/useExitOnCtrlCDWithKeybindings.js'
import { tSync } from '../i18n/index.js'
import { Box, Link, Text } from '../ink/index.js'
import { ConfigurableShortcutHint } from './ConfigurableShortcutHint.js'
import { SelectMulti } from './CustomSelect/SelectMulti.js'
import { Byline } from './design-system/Byline.js'
import { Dialog } from './design-system/Dialog.js'
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js'

type WorkflowOption = {
  value: Workflow
  label: string
}
type Props = {
  onSubmit: (selectedWorkflows: Workflow[]) => void
  defaultSelections: Workflow[]
}
const WORKFLOWS: WorkflowOption[] = [
  {
    value: 'zy' as const,
    label: '@ZY Code - Tag @zy in issues and PR comments',
  },
  {
    value: 'zy-review' as const,
    label: 'ZY Code Review - Automated code review on new PRs',
  },
]
function renderInputGuide(exitState: ExitState): React.ReactNode {
  if (exitState.pending) {
    return (
      <Text>{tSync('workflowDialog.pressAgainToExit', { keyName: exitState.keyName ?? '' })}</Text>
    )
  }
  return (
    <Byline>
      <KeyboardShortcutHint shortcut="↑↓" action="navigate" />
      <KeyboardShortcutHint shortcut="Space" action="toggle" />
      <KeyboardShortcutHint shortcut="Enter" action="confirm" />
      <ConfigurableShortcutHint
        action="confirm:no"
        context="Confirmation"
        fallback="Esc"
        description="cancel"
      />
    </Byline>
  )
}
export function WorkflowMultiselectDialog({ onSubmit, defaultSelections }: Props) {
  const [showError, setShowError] = useState(false)
  const handleSubmit = (selectedValues: string[]) => {
    if (selectedValues.length === 0) {
      setShowError(true)
      return
    }
    setShowError(false)
    onSubmit(selectedValues as Workflow[])
  }
  const handleChange = () => {
    setShowError(false)
  }
  const handleCancel = () => {
    setShowError(true)
  }
  const workflowOptions = WORKFLOWS.map((workflow) => ({
    label: workflow.label,
    value: workflow.value,
  }))
  return (
    <Dialog
      title="Select GitHub workflows to install"
      subtitle="We'll create a workflow file in your repository for each one you select."
      onCancel={handleCancel}
      inputGuide={renderInputGuide}
    >
      {
        <Box>
          <Text dimColor={true}>
            More workflow examples (issue triage, CI fixes, etc.) at:{' '}
            <Link url="https://github.com/zy-ai/zy-code-action/blob/main/examples/">
              https://github.com/zy-ai/zy-code-action/blob/main/examples/
            </Link>
          </Text>
        </Box>
      }
      {
        <SelectMulti
          options={workflowOptions}
          defaultValue={defaultSelections}
          onSubmit={handleSubmit}
          onChange={handleChange}
          onCancel={handleCancel}
          hideIndexes={true}
        />
      }
      {showError && (
        <Box>
          <Text color="error">You must select at least one workflow to continue</Text>
        </Box>
      )}
    </Dialog>
  )
}
