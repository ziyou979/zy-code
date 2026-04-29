import figures from 'figures';
import React, { useMemo, useState } from 'react';
import type { SDKMessage } from 'src/entrypoints/agentSdkTypes.js';
import type { ToolUseContext } from 'src/Tool.js';
import type { DeepImmutable } from 'src/types/utils.js';
import type { CommandResultDisplay } from '../../commands.js';
import { DIAMOND_FILLED, DIAMOND_OPEN } from '../../constants/figures.js';
import { useElapsedTime } from '../../hooks/useElapsedTime.js';
import type { KeyboardEvent } from '../../ink/events/keyboard-event.js';
import { Box, Link, Text } from '../../ink.js';
import type { RemoteAgentTaskState } from '../../tasks/RemoteAgentTask/RemoteAgentTask.js';
import { getRemoteTaskSessionUrl } from '../../tasks/RemoteAgentTask/RemoteAgentTask.js';
import { AGENT_TOOL_NAME, LEGACY_AGENT_TOOL_NAME } from '../../tools/AgentTool/constants.js';
import { ASK_USER_QUESTION_TOOL_NAME } from '../../tools/AskUserQuestionTool/prompt.js';
import { EXIT_PLAN_MODE_V2_TOOL_NAME } from '../../tools/ExitPlanModeTool/constants.js';
import { openBrowser } from '../../utils/browser.js';
import { errorMessage } from '../../utils/errors.js';
import { formatDuration, truncateToWidth } from '../../utils/format.js';
import { toInternalMessages } from '../../utils/messages/mappers.js';
import { EMPTY_LOOKUPS, normalizeMessages } from '../../utils/messages.js';
import { plural } from '../../utils/stringUtils.js';
import { teleportResumeCodeSession } from '../../utils/teleport.js';
import { Select } from '../CustomSelect/select.js';
import { Byline } from '../design-system/Byline.js';
import { Dialog } from '../design-system/Dialog.js';
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js';
import { Message } from '../Message.js';
import { tSync } from '../../i18n/index.js';
import { formatReviewStageCounts, RemoteSessionProgress } from './RemoteSessionProgress.js';
type Props = {
  session: DeepImmutable<RemoteAgentTaskState>;
  toolUseContext: ToolUseContext;
  onDone: (result?: string, options?: {
    display?: CommandResultDisplay;
  }) => void;
  onBack?: () => void;
  onKill?: () => void;
};

// Compact one-line summary: tool name + first meaningful string arg.
// Lighter than tool.renderToolUseMessage (no registry lookup / schema parse).
// Collapses whitespace so multi-line inputs (e.g. Bash command text)
// render on one line.
export function formatToolUseSummary(name: string, input: unknown): string {
  // plan_ready phase is only reached via ExitPlanMode tool
  if (name === EXIT_PLAN_MODE_V2_TOOL_NAME) {
    return tSync('backgroundTasks.reviewPlanOnWeb');
  }
  if (!input || typeof input !== 'object') return name;
  // AskUserQuestion: show the question text as a CTA, not the tool name.
  // Input shape is {questions: [{question, header, options}]}.
  if (name === ASK_USER_QUESTION_TOOL_NAME && 'questions' in input) {
    const qs = input.questions;
    if (Array.isArray(qs) && qs[0] && typeof qs[0] === 'object') {
      // Prefer question (full text) over header (max-12-char tag). header
      // is a required schema field so checking it first would make the
      // question fallback dead code.
      const q = 'question' in qs[0] && typeof qs[0].question === 'string' && qs[0].question ? qs[0].question : 'header' in qs[0] && typeof qs[0].header === 'string' ? qs[0].header : null;
      if (q) {
        const oneLine = q.replace(/\s+/g, ' ').trim();
        return `${tSync('backgroundTasks.answerInBrowser')}: ${truncateToWidth(oneLine, 50)}`;
      }
    }
  }
  for (const v of Object.values(input)) {
    if (typeof v === 'string' && v.trim()) {
      const oneLine = v.replace(/\s+/g, ' ').trim();
      return `${name} ${truncateToWidth(oneLine, 60)}`;
    }
  }
  return name;
}
const PHASE_LABEL = {
  needs_input: tSync('backgroundTasks.inputRequired'),
  plan_ready: tSync('backgroundTasks.ready')
} as const;
const AGENT_VERB = {
  needs_input: tSync('backgroundTasks.waiting'),
  plan_ready: tSync('backgroundTasks.done')
} as const;
function UltraplanSessionDetail({
  session,
  onDone,
  onBack,
  onKill
}) {
  const running = session.status === "running" || session.status === "pending";
  const phase = session.ultraplanPhase;
  const statusText = running ? phase ? PHASE_LABEL[phase] : "running" : session.status;
  const elapsedTime = useElapsedTime(session.startTime, running, 1000, 0, session.endTime);
  let spawns = 0;
  let calls = 0;
  let lastBlock = null;
  for (const msg of session.log) {
    if (msg.type !== "assistant") {
      continue;
    }
    for (const block of msg.message.content) {
      if (block.type !== "tool_use") {
        continue;
      }
      calls++;
      lastBlock = block;
      if (block.name === AGENT_TOOL_NAME || block.name === LEGACY_AGENT_TOOL_NAME) {
        spawns++;
      }
    }
  }
  const t2 = lastBlock ? formatToolUseSummary(lastBlock.name, lastBlock.input) : null;
  const {
    agentsWorking,
    toolCalls,
    lastToolCall
  } = {
    agentsWorking: 1 + spawns,
    toolCalls: calls,
    lastToolCall: t2
  };
  const sessionUrl = getRemoteTaskSessionUrl(session.sessionId);
  const goBackOrClose = onBack ?? (() => onDone("Remote session details dismissed", {
    display: "system"
  }));
  const [confirmingStop, setConfirmingStop] = useState(false);
  if (confirmingStop) {
    return <Dialog title={tSync('backgroundTasks.stopUltraplan')} onCancel={() => setConfirmingStop(false)} color="background"><Box flexDirection="column" gap={1}>{<Text dimColor={true}>{tSync('backgroundTasks.stopUltraplanConfirm')}</Text>}<Select options={[{
          label: tSync('backgroundTasks.terminateSession'),
          value: "stop" as const
        }, {
          label: tSync('backgroundTasks.back'),
          value: "back" as const
        }]} onChange={v => {
          if (v === "stop") {
            onKill?.();
            goBackOrClose();
          } else {
            setConfirmingStop(false);
          }
        }} /></Box></Dialog>;
  }
  const t12 = plural(agentsWorking, "agent");
  const t14 = plural(toolCalls, "call");
  return <Dialog title={<Text>{<Text color="background">{phase === "plan_ready" ? DIAMOND_FILLED : DIAMOND_OPEN}{" "}</Text>}{<Text bold={true}>ultraplan</Text>}{<Text dimColor={true}>{" \xB7 "}{elapsedTime}{" \xB7 "}{statusText}</Text>}</Text>} onCancel={goBackOrClose} color="background">{<Box flexDirection="column" gap={1}>{<Text>{phase === "plan_ready" && <Text color="success">{figures.tick} </Text>}{agentsWorking} {t12}{" "}{phase ? AGENT_VERB[phase] : tSync('backgroundTasks.working')} · {toolCalls} tool{" "}{t14}</Text>}{lastToolCall && <Text dimColor={true}>{lastToolCall}</Text>}{<Link url={sessionUrl}>{<Text dimColor={true}>{sessionUrl}</Text>}</Link>}{<Select options={[{
        label: tSync('backgroundTasks.reviewOnWeb'),
        value: "open" as const
      }, ...(onKill && running ? [{
        label: tSync('backgroundTasks.stopUltraplanLabel'),
        value: "stop" as const
      }] : []), {
        label: tSync('backgroundTasks.back'),
        value: "back" as const
      }]} onChange={v_0 => {
        switch (v_0) {
          case "open":
            {
              openBrowser(sessionUrl);
              onDone();
              return;
            }
          case "stop":
            {
              setConfirmingStop(true);
              return;
            }
          case "back":
            {
              goBackOrClose();
              return;
            }
        }
      }} />}</Box>}</Dialog>;
}
const STAGES = ['finding', 'verifying', 'synthesizing'] as const;
const STAGE_LABELS: Record<(typeof STAGES)[number], string> = {
  finding: tSync('backgroundTasks.stageFind'),
  verifying: tSync('backgroundTasks.stageVerify'),
  synthesizing: tSync('backgroundTasks.stageDedupe')
};

// Setup → Find → Verify → Dedupe pipeline. Current stage in cloud teal,
// rest dim. When completed, all stages dim with a trailing green ✓. The
// "Setup" label shows before the orchestrator writes its first progress
// snapshot (container boot + repo clone), so the 0-found display doesn't
// look like a hung finder.
function StagePipeline({
  stage,
  completed,
  hasProgress
}) {
  const currentIdx = stage ? STAGES.indexOf(stage) : -1;
  const inSetup = !completed && !hasProgress;
  const t4 = STAGES.map((s, i) => {
    const isCurrent = !completed && !inSetup && i === currentIdx;
    return <React.Fragment key={s}>{i > 0 && <Text dimColor={true}> → </Text>}{isCurrent ? <Text color="background">{STAGE_LABELS[s]}</Text> : <Text dimColor={true}>{STAGE_LABELS[s]}</Text>}</React.Fragment>;
  });
  return <Text>{inSetup ? <Text color="background">{tSync('backgroundTasks.stageSetup')}</Text> : <Text dimColor={true}>{tSync('backgroundTasks.stageSetup')}</Text>}{<Text dimColor={true}> → </Text>}{t4}{completed && <Text color="success"> ✓</Text>}</Text>;
}

// Stage-appropriate counts line. Running-state formatting delegates to
// formatReviewStageCounts (shared with the pill) so the two views can't
// drift; completed state is dialog-specific (findings summary).
function reviewCountsLine(session: DeepImmutable<RemoteAgentTaskState>): string {
  const p = session.reviewProgress;
  // No progress data — the orchestrator never wrote a snapshot. Don't
  // claim "0 findings" when completed; we just don't know.
  if (!p) return session.status === 'completed' ? tSync('backgroundTasks.done') : tSync('backgroundTasks.settingUp');
  const verified = p.bugsVerified;
  const refuted = p.bugsRefuted ?? 0;
  if (session.status === 'completed') {
    const parts = [`${verified} ${plural(verified, 'finding')}`];
    if (refuted > 0) parts.push(`${refuted} refuted`);
    return parts.join(' · ');
  }
  return formatReviewStageCounts(p.stage, p.bugsFound, verified, refuted);
}
type MenuAction = 'open' | 'stop' | 'back' | 'dismiss';
function ReviewSessionDetail({
  session,
  onDone,
  onBack,
  onKill
}) {
  const completed = session.status === "completed";
  const running = session.status === "running" || session.status === "pending";
  const [confirmingStop, setConfirmingStop] = useState(false);
  const elapsedTime = useElapsedTime(session.startTime, running, 1000, 0, session.endTime);
  const handleClose = () => onDone("Remote session details dismissed", {
    display: "system"
  });
  const goBackOrClose = onBack ?? handleClose;
  const sessionUrl = getRemoteTaskSessionUrl(session.sessionId);
  const statusLabel = completed ? tSync('backgroundTasks.ready') : running ? tSync('backgroundTasks.running') : session.status;
  if (confirmingStop) {
    return <Dialog title={tSync('backgroundTasks.stopUltrareview')} onCancel={() => setConfirmingStop(false)} color="background"><Box flexDirection="column" gap={1}>{<Text dimColor={true}>{tSync('backgroundTasks.stopUltrareviewConfirm')}</Text>}<Select options={[{
          label: tSync('backgroundTasks.stopUltrareviewLabel'),
          value: "stop" as const
        }, {
          label: tSync('backgroundTasks.back'),
          value: "back" as const
        }]} onChange={v => {
          if (v === "stop") {
            onKill?.();
            goBackOrClose();
          } else {
            setConfirmingStop(false);
          }
        }} /></Box></Dialog>;
  }
  const options = completed ? [{
    label: tSync('backgroundTasks.openOnWeb'),
    value: "open"
  }, {
    label: tSync('backgroundTasks.dismiss'),
    value: "dismiss"
  }] : [{
    label: tSync('backgroundTasks.openOnWeb'),
    value: "open"
  }, ...(onKill && running ? [{
    label: tSync('backgroundTasks.stopUltrareviewLabel'),
    value: "stop" as const
  }] : []), {
    label: tSync('backgroundTasks.back'),
    value: "back"
  }];
  const handleSelect = action => {
    switch (action) {
      case "open":
        {
          openBrowser(sessionUrl);
          onDone();
          break;
        }
      case "stop":
        {
          setConfirmingStop(true);
          break;
        }
      case "back":
        {
          goBackOrClose();
          break;
        }
      case "dismiss":
        {
          handleClose();
        }
    }
  };
  const t10 = session.reviewProgress?.stage;
  const t13 = reviewCountsLine(session);
  return <Dialog title={<Text>{<Text color="background">{completed ? DIAMOND_FILLED : DIAMOND_OPEN}{" "}</Text>}{<Text bold={true}>ultrareview</Text>}{<Text dimColor={true}>{" \xB7 "}{elapsedTime}{" \xB7 "}{statusLabel}</Text>}</Text>} onCancel={goBackOrClose} color="background" inputGuide={exitState => exitState.pending ? <Text>Press {exitState.keyName} again to exit</Text> : <Byline><KeyboardShortcutHint shortcut="Enter" action="select" /><KeyboardShortcutHint shortcut="Esc" action="go back" /></Byline>}>{<Box flexDirection="column" gap={1}>{<StagePipeline stage={t10} completed={completed} hasProgress={!!session.reviewProgress} />}{<Box flexDirection="column">{<Text>{t13}</Text>}{<Link url={sessionUrl}>{<Text dimColor={true}>{sessionUrl}</Text>}</Link>}</Box>}{<Select options={options} onChange={handleSelect} />}</Box>}</Dialog>;
}
export function RemoteSessionDetailDialog({
  session,
  toolUseContext,
  onDone,
  onBack,
  onKill
}: Props): React.ReactNode {
  const [isTeleporting, setIsTeleporting] = useState(false);
  const [teleportError, setTeleportError] = useState<string | null>(null);

  // Get last few messages from remote session for display.
  // Scan all messages (not just the last 3 raw entries) because the tail of
  // the log is often thinking-only blocks that normalise to 'progress' type.
  // Placed before the early returns so hook call order is stable (Rules of Hooks).
  // Ultraplan/review sessions never read this — skip the normalize work for them.
  const lastMessages = useMemo(() => {
    if (session.isUltraplan || session.isRemoteReview) return [];
    return normalizeMessages(toInternalMessages(session.log as SDKMessage[])).filter(_ => _.type !== 'progress').slice(-3);
  }, [session]);
  if (session.isUltraplan) {
    return <UltraplanSessionDetail session={session} onDone={onDone} onBack={onBack} onKill={onKill} />;
  }

  // Review sessions get the stage-pipeline view; everything else keeps the
  // generic label/value + recent-messages dialog below.
  if (session.isRemoteReview) {
    return <ReviewSessionDetail session={session} onDone={onDone} onBack={onBack} onKill={onKill} />;
  }
  const handleClose = () => onDone('Remote session details dismissed', {
    display: 'system'
  });

  // Component-specific shortcuts shown in UI hints (t=teleport, space=dismiss,
  // left=back). These are state-dependent actions, not standard dialog keybindings.
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === ' ') {
      e.preventDefault();
      onDone('Remote session details dismissed', {
        display: 'system'
      });
    } else if (e.key === 'left' && onBack) {
      e.preventDefault();
      onBack();
    } else if (e.key === 't' && !isTeleporting) {
      e.preventDefault();
      void handleTeleport();
    } else if (e.key === 'return') {
      e.preventDefault();
      handleClose();
    }
  };

  // Handle teleporting to remote session
  async function handleTeleport(): Promise<void> {
    setIsTeleporting(true);
    setTeleportError(null);
    try {
      await teleportResumeCodeSession(session.sessionId);
    } catch (err) {
      setTeleportError(errorMessage(err));
    } finally {
      setIsTeleporting(false);
    }
  }

  // Truncate title if too long (for display purposes)
  const displayTitle = truncateToWidth(session.title, 50);

  // Map TaskStatus to display status (handle 'pending')
  const displayStatus = session.status === 'pending' ? tSync('backgroundTasks.starting') : session.status;
  return <Box flexDirection="column" tabIndex={0} autoFocus onKeyDown={handleKeyDown}>
      <Dialog title={tSync('backgroundTasks.remoteSessionDetails')} onCancel={handleClose} color="background" inputGuide={exitState => exitState.pending ? <Text>Press {exitState.keyName} again to exit</Text> : <Byline>
              {onBack && <KeyboardShortcutHint shortcut="←" action="go back" />}
              <KeyboardShortcutHint shortcut="Esc/Enter/Space" action="close" />
              {!isTeleporting && <KeyboardShortcutHint shortcut="t" action="teleport" />}
            </Byline>}>
        <Box flexDirection="column">
          <Text>
            <Text bold>{tSync('backgroundTasks.status')}</Text>:{' '}
            {displayStatus === 'running' || displayStatus === 'starting' ? <Text color="background">{displayStatus}</Text> : displayStatus === 'completed' ? <Text color="success">{displayStatus}</Text> : <Text color="error">{displayStatus}</Text>}
          </Text>
          <Text>
            <Text bold>{tSync('backgroundTasks.runtime')}</Text>:{' '}
            {formatDuration((session.endTime ?? Date.now()) - session.startTime)}
          </Text>
          <Text wrap="truncate-end">
            <Text bold>{tSync('backgroundTasks.titleLabel')}</Text>: {displayTitle}
          </Text>
          <Text>
            <Text bold>{tSync('backgroundTasks.progress')}</Text>:{' '}
            <RemoteSessionProgress session={session} />
          </Text>
          <Text>
            <Text bold>{tSync('backgroundTasks.sessionUrl')}</Text>:{' '}
            <Link url={getRemoteTaskSessionUrl(session.sessionId)}>
              <Text dimColor>{getRemoteTaskSessionUrl(session.sessionId)}</Text>
            </Link>
          </Text>
        </Box>

        {/* Remote session messages section */}
        {session.log.length > 0 && <Box flexDirection="column" marginTop={1}>
            <Text>
              <Text bold>{tSync('backgroundTasks.recentMessages')}</Text>:
            </Text>
            <Box flexDirection="column" height={10} overflowY="hidden">
              {lastMessages.map((msg, i) => <Message key={i} message={msg} lookups={EMPTY_LOOKUPS} addMargin={i > 0} tools={toolUseContext.options.tools} commands={toolUseContext.options.commands} verbose={toolUseContext.options.verbose} inProgressToolUseIDs={new Set()} progressMessagesForMessage={[]} shouldAnimate={false} shouldShowDot={false} style="condensed" isTranscriptMode={false} isStatic={true} />)}
            </Box>
            <Box marginTop={1}>
              <Text dimColor italic>
                {tSync('backgroundTasks.showingLastMessages', { shown: lastMessages.length, total: session.log.length })}
              </Text>
            </Box>
          </Box>}

        {/* Teleport error message */}
        {teleportError && <Box marginTop={1}>
            <Text color="error">{tSync('backgroundTasks.teleportFailed', { error: teleportError })}</Text>
          </Box>}

        {/* Teleporting status */}
        {isTeleporting && <Text color="background">{tSync('backgroundTasks.teleporting')}</Text>}
      </Dialog>
    </Box>;
}
