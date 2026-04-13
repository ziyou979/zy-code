import figures from 'figures';
import * as React from 'react';
import { Box, Text, type TextProps } from '../../ink.js';
import { useAppState } from '../../state/AppState.js';
import { getRunningTeammatesSorted } from '../../tasks/InProcessTeammateTask/InProcessTeammateTask.js';
import { formatNumber } from '../../utils/format.js';
import { TeammateSpinnerLine } from './TeammateSpinnerLine.js';
import { TEAMMATE_SELECT_HINT } from './teammateSelectHint.js';
type Props = {
  selectedIndex?: number;
  isInSelectionMode?: boolean;
  allIdle?: boolean;
  /** Leader's active verb (when leader is actively processing) */
  leaderVerb?: string;
  /** Leader's token count (when leader is actively processing) */
  leaderTokenCount?: number;
  /** Leader's idle status text (when leader is idle, e.g. "✻ Idle for 3s") */
  leaderIdleText?: string;
};
export function TeammateSpinnerTree({
  selectedIndex,
  isInSelectionMode,
  allIdle,
  leaderVerb,
  leaderTokenCount,
  leaderIdleText
}: Props) {
  const tasks = useAppState(s => s.tasks);
  const viewingAgentTaskId = useAppState(s_0 => s_0.viewingAgentTaskId);
  const showTeammateMessagePreview = useAppState(s_1 => s_1.showTeammateMessagePreview);
  let T0;
  let isHideSelected;
  let t1;
  let t2;
  let t4;
  let t5;
  t5 = Symbol.for("react.early_return_sentinel");
  const teammateTasks = getRunningTeammatesSorted(tasks);
  if (teammateTasks.length === 0) {
    t5 = null;
  } else {
    const isLeaderForegrounded = viewingAgentTaskId === undefined;
    const isLeaderSelected = isInSelectionMode && selectedIndex === -1;
    const isLeaderHighlighted = isLeaderForegrounded || isLeaderSelected;
    isHideSelected = isInSelectionMode === true && selectedIndex === teammateTasks.length;
    T0 = Box;
    t1 = "column";
    t2 = 1;
    const t3 = <Box paddingLeft={3}>{<Text color={isLeaderSelected ? "suggestion" : undefined} bold={isLeaderHighlighted}>{isLeaderSelected ? figures.pointer : " "}</Text>}{<Text dimColor={!isLeaderHighlighted} bold={isLeaderHighlighted}>{isLeaderHighlighted ? "\u2552\u2550" : "\u250C\u2500"}{" "}</Text>}{<Text bold={isLeaderHighlighted} color={isLeaderSelected ? "suggestion" : "cyan_FOR_SUBAGENTS_ONLY"}>team-lead</Text>}{!isLeaderForegrounded && leaderVerb && <Text dimColor={true}>: {leaderVerb}…</Text>}{!isLeaderForegrounded && !leaderVerb && leaderIdleText && <Text dimColor={true}>: {leaderIdleText}</Text>}{leaderTokenCount !== undefined && leaderTokenCount > 0 && <Text dimColor={!isLeaderHighlighted}>{" "}· {formatNumber(leaderTokenCount)} tokens</Text>}{isLeaderHighlighted && <Text dimColor={true}> · {TEAMMATE_SELECT_HINT}</Text>}{isLeaderSelected && !isLeaderForegrounded && <Text dimColor={true}> · enter to view</Text>}</Box>;
    t4 = teammateTasks.map((teammate, index) => <TeammateSpinnerLine key={teammate.id} teammate={teammate} isLast={!isInSelectionMode && index === teammateTasks.length - 1} isSelected={isInSelectionMode && selectedIndex === index} isForegrounded={viewingAgentTaskId === teammate.id} allIdle={allIdle} showPreview={showTeammateMessagePreview} />);
  }
  if (t5 !== Symbol.for("react.early_return_sentinel")) {
    return t5;
  }
  return <T0 flexDirection={t1} marginTop={t2}>{t3}{t4}{isInSelectionMode && <HideRow isSelected={isHideSelected} />}</T0>;
}
function HideRow({
  isSelected
}) {
  return <Box paddingLeft={3}>{<Text color={isSelected ? "suggestion" : undefined} bold={isSelected}>{isSelected ? figures.pointer : " "}</Text>}{<Text dimColor={!isSelected} bold={isSelected}>{isSelected ? "\u2558\u2550" : "\u2514\u2500"}{" "}</Text>}{<Text dimColor={!isSelected} bold={isSelected}>hide</Text>}{isSelected && <Text dimColor={true}> · enter to collapse</Text>}</Box>;
}
