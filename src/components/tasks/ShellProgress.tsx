import React from 'react';
import { tSync } from 'src/i18n/index.js';
import { Text } from 'src/ink.js';
import type { TaskStatus } from 'src/Task.js';
type TaskStatusTextProps = {
  status: TaskStatus;
  label?: string;
  suffix?: string;
};
export function TaskStatusText({
  status,
  label,
  suffix
}: TaskStatusTextProps) {
  const displayLabel = label ?? status;
  const color = status === "completed" ? "success" : status === "failed" ? "error" : status === "killed" ? "warning" : undefined;
  return <Text color={color} dimColor={true}>({displayLabel}{suffix})</Text>;
}
type ShellProgressProps = {
  shell: { status: TaskStatus };
};
export function ShellProgress({
  shell
}: ShellProgressProps) {
  switch (shell.status) {
    case "completed":
      {
        let t1;
        t1 = <TaskStatusText status="completed" label={tSync('shellProgress.done')} />;
        return t1;
      }
    case "failed":
      {
        let t1;
        t1 = <TaskStatusText status="failed" label={tSync('shellProgress.error')} />;
        return t1;
      }
    case "killed":
      {
        let t1;
        t1 = <TaskStatusText status="killed" label={tSync('shellProgress.stopped')} />;
        return t1;
      }
    case "running":
    case "pending":
      {
        let t1;
        t1 = <TaskStatusText status="running" />;
        return t1;
      }
  }
}
