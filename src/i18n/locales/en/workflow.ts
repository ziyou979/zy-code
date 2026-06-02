import type { TranslationResource } from '../resourceTypes.js'

export const enWorkflow: TranslationResource = {
  'workflow.error.inputRequired': 'One of script, scriptPath, or name is required.',
  'workflow.error.inputExclusive': 'Only one of script, scriptPath, or name may be provided.',
  'workflow.error.namedNotFound':
    'Named workflow "{name}" not found. Place .js workflow files in ~/.zy/workflows/ or <project>/workflows/.',
  'workflow.error.runtimeNotAvailable':
    'Workflow runtime is not yet available. The script was validated but cannot be executed in this build. This capability is under active development.',
  'workflow.launched':
    'Workflow "{name}" launched. You will receive a <task-notification> when it completes. Use /workflows to check progress.',
  'workflow.completed': 'Completed with {count} agent(s).',
  'workflow.completedWithResult': 'Completed with {count} agent(s). Result: {result}',
  'workflow.failed': 'Workflow failed: {error}',
  'workflow.stopped': 'Workflow was stopped',
  'workflow.error.resumeStillRunning':
    'Workflow {runId} is still running (task {taskId}). Stop it first with TaskStop({{taskId: "{taskId}"}}) before resuming.',
}
