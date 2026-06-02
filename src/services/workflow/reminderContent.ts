import {
  getUltracodeEnterReminderText,
  getUltracodeExitReminderText,
  getWorkflowKeywordReminderText,
} from './reminders.js'

type WorkflowReminderKind =
  | 'ultracode_enter_full'
  | 'ultracode_enter_light'
  | 'ultracode_exit'
  | 'workflow_keyword_request'

export function getWorkflowReminderContent(kind: WorkflowReminderKind): string {
  switch (kind) {
    case 'ultracode_enter_full':
      return getUltracodeEnterReminderText('full')
    case 'ultracode_enter_light':
      return getUltracodeEnterReminderText('light')
    case 'ultracode_exit':
      return getUltracodeExitReminderText()
    case 'workflow_keyword_request':
      return getWorkflowKeywordReminderText()
  }
}
