// Local Workflow Task module stub implementation
// This module provides workflow task functionality for WORKFLOW_SCRIPTS feature

import type { SetAppState, Task, TaskStateBase } from '../../Task.js';

export type LocalWorkflowTaskState = TaskStateBase & {
  type: 'local_workflow';
  workflowId: string;
  workflowName?: string;
  scriptPath?: string;
  summary?: string;
  agentCount?: number;
  error?: string;
};

/**
 * LocalWorkflowTask class implementing the Task interface
 */
export const LocalWorkflowTask: Task = {
  name: 'LocalWorkflowTask',
  type: 'local_workflow',
  async kill(taskId: string, setAppState: SetAppState): Promise<void> {
    // Stub implementation - update task status to killed
    // In real implementation, this would terminate the workflow process
  }
};

/**
 * Kill a workflow task
 * @param taskId - The task ID to kill
 * @param setAppState - State setter function
 */
export async function killWorkflowTask(
  taskId: string,
  setAppState: SetAppState
): Promise<void> {
  // Stub implementation
}

/**
 * Skip workflow agent execution
 * @param taskId - The task ID to skip
 * @param setAppState - State setter function
 */
export function skipWorkflowAgent(
  taskId: string,
  setAppState: SetAppState
): void {
  // Stub implementation
}

/**
 * Retry workflow agent execution
 * @param taskId - The task ID to retry
 * @param setAppState - State setter function
 */
export function retryWorkflowAgent(
  taskId: string,
  setAppState: SetAppState
): void {
  // Stub implementation
}
