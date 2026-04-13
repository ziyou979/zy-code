import * as React from 'react';
import { Text } from 'src/ink.js';
import type { BackgroundTaskState } from 'src/tasks/types.js';
import type { DeepImmutable } from 'src/types/utils.js';
import { truncate } from 'src/utils/format.js';
import { toInkColor } from 'src/utils/ink.js';
import { plural } from 'src/utils/stringUtils.js';
import { DIAMOND_FILLED, DIAMOND_OPEN } from '../../constants/figures.js';
import { RemoteSessionProgress } from './RemoteSessionProgress.js';
import { ShellProgress, TaskStatusText } from './ShellProgress.js';
import { describeTeammateActivity } from './taskStatusUtils.js';
type Props = {
  task: DeepImmutable<BackgroundTaskState>;
  maxActivityWidth?: number;
};
export function BackgroundTask({
  task,
  maxActivityWidth
}: Props) {
  const activityLimit = maxActivityWidth ?? 40;
  switch (task.type) {
    case "local_bash":
      {
        const t1 = task.kind === "monitor" ? task.description : task.command;
        let t2;
        t2 = truncate(t1, activityLimit, true);
        let t3;
        t3 = <ShellProgress shell={task} />;
        let t4;
        t4 = <Text>{t2}{" "}{t3}</Text>;
        return t4;
      }
    case "remote_agent":
      {
        if (task.isRemoteReview) {
          let t1;
          t1 = <Text><RemoteSessionProgress session={task} /></Text>;
          return t1;
        }
        const running = task.status === "running" || task.status === "pending";
        const t1 = running ? DIAMOND_OPEN : DIAMOND_FILLED;
        let t2;
        t2 = <Text dimColor={true}>{t1} </Text>;
        let t3;
        t3 = truncate(task.title, activityLimit, true);
        let t4;
        t4 = <Text dimColor={true}> · </Text>;
        let t5;
        t5 = <RemoteSessionProgress session={task} />;
        let t6;
        t6 = <Text>{t2}{t3}{t4}{t5}</Text>;
        return t6;
      }
    case "local_agent":
      {
        let t1;
        t1 = truncate(task.description, activityLimit, true);
        const t2 = task.status === "completed" ? "done" : undefined;
        const t3 = task.status === "completed" && !task.notified ? ", unread" : undefined;
        let t4;
        t4 = <TaskStatusText status={task.status} label={t2} suffix={t3} />;
        let t5;
        t5 = <Text>{t1}{" "}{t4}</Text>;
        return t5;
      }
    case "in_process_teammate":
      {
        let T0;
        let T1;
        let t1;
        let t2;
        let t3;
        let t4;
        const activity = describeTeammateActivity(task);
        T1 = Text;
        let t5;
        t5 = toInkColor(task.identity.color);
        t4 = <Text color={t5}>@{task.identity.agentName}</Text>;
        T0 = Text;
        t1 = true;
        t2 = ": ";
        t3 = truncate(activity, activityLimit, true);
        t5 = <T0 dimColor={t1}>{t2}{t3}</T0>;
        let t6;
        t6 = <T1>{t4}{t5}</T1>;
        return t6;
      }
    case "local_workflow":
      {
        const t1 = task.workflowName ?? task.summary ?? task.description;
        let t2;
        t2 = truncate(t1, activityLimit, true);
        let t3;
        t3 = task.status === "running" ? `${task.agentCount} ${plural(task.agentCount, "agent")}` : task.status === "completed" ? "done" : undefined;
        const t4 = task.status === "completed" && !task.notified ? ", unread" : undefined;
        let t5;
        t5 = <TaskStatusText status={task.status} label={t3} suffix={t4} />;
        let t6;
        t6 = <Text>{t2}{" "}{t5}</Text>;
        return t6;
      }
    case "monitor_mcp":
      {
        let t1;
        t1 = truncate(task.description, activityLimit, true);
        const t2 = task.status === "completed" ? "done" : undefined;
        const t3 = task.status === "completed" && !task.notified ? ", unread" : undefined;
        let t4;
        t4 = <TaskStatusText status={task.status} label={t2} suffix={t3} />;
        let t5;
        t5 = <Text>{t1}{" "}{t4}</Text>;
        return t5;
      }
    case "dream":
      {
        const n = task.filesTouched.length;
        let t1;
        t1 = task.phase === "updating" && n > 0 ? `${n} ${plural(n, "file")}` : `${task.sessionsReviewing} ${plural(task.sessionsReviewing, "session")}`;
        const detail = t1;
        let t2;
        t2 = <Text dimColor={true}>· {task.phase} · {detail}</Text>;
        const t3 = task.status === "completed" ? "done" : undefined;
        const t4 = task.status === "completed" && !task.notified ? ", unread" : undefined;
        let t5;
        t5 = <TaskStatusText status={task.status} label={t3} suffix={t4} />;
        let t6;
        t6 = <Text>{task.description}{" "}{t2}{" "}{t5}</Text>;
        return t6;
      }
  }
}
