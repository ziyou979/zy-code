import { feature } from 'bun:bundle';
import { basename } from 'path';
import React, { useRef } from 'react';
import { useMinDisplayTime } from '../../hooks/useMinDisplayTime.js';
import { Ansi, Box, Text, useTheme } from '../../ink.js';
import { findToolByName, type Tools } from '../../Tool.js';
import { getReplPrimitiveTools } from '../../tools/REPLTool/primitiveTools.js';
import type { CollapsedReadSearchGroup, NormalizedAssistantMessage } from '../../types/message.js';
import { uniq } from '../../utils/array.js';
import { getToolUseIdsFromCollapsedGroup } from '../../utils/collapseReadSearch.js';
import { getDisplayPath } from '../../utils/file.js';
import { formatDuration, formatSecondsShort } from '../../utils/format.js';
import { isFullscreenEnvEnabled } from '../../utils/fullscreen.js';
import type { buildMessageLookups } from '../../utils/messages.js';
import type { ThemeName } from '../../utils/theme.js';
import { tSync } from '../../i18n/index.js';
import { CtrlOToExpand } from '../CtrlOToExpand.js';
import { useSelectedMessageBg } from '../messageActions.js';
import { PrBadge } from '../PrBadge.js';
import { ToolUseLoader } from '../ToolUseLoader.js';

/* eslint-disable @typescript-eslint/no-require-imports */
const teamMemCollapsed = feature('TEAMMEM') ? require('./teamMemCollapsed.js') as typeof import('./teamMemCollapsed.js') : null;
/* eslint-enable @typescript-eslint/no-require-imports */

// Hold each ⤿ hint for a minimum duration so fast-completing tool calls
// (bash commands, file reads, search patterns) are actually readable instead
// of flickering past in a single frame.
const MIN_HINT_DISPLAY_MS = 700;
type Props = {
  message: CollapsedReadSearchGroup;
  inProgressToolUseIDs: Set<string>;
  shouldAnimate: boolean;
  verbose: boolean;
  tools: Tools;
  lookups: ReturnType<typeof buildMessageLookups>;
  /** True if this is the currently active collapsed group (last one, still loading) */
  isActiveGroup?: boolean;
};

/** Render a single tool use in verbose mode */
function VerboseToolUse({
  content,
  tools,
  lookups,
  inProgressToolUseIDs,
  shouldAnimate,
  theme
}: Props) {
  const bg = useSelectedMessageBg();
  let t1;
  let t2;
  t2 = Symbol.for("react.early_return_sentinel");
  const tool = findToolByName(tools, content.name) ?? findToolByName(getReplPrimitiveTools(), content.name);
  if (!tool) {
    t2 = null;
  } else {
    const isResolved = lookups.resolvedToolUseIDs.has(content.id);
    const isError = lookups.erroredToolUseIDs.has(content.id);
    const isInProgress = inProgressToolUseIDs.has(content.id);
    const resultMsg = lookups.toolResultByToolUseID.get(content.id);
    const rawToolResult = resultMsg?.type === "user" ? resultMsg.toolUseResult : undefined;
    const parsedOutput = tool.outputSchema?.safeParse(rawToolResult);
    const toolResult = parsedOutput?.success ? parsedOutput.data : undefined;
    const parsedInput = tool.inputSchema.safeParse(content.input);
    const input = parsedInput.success ? parsedInput.data : undefined;
    const userFacingName = tool.userFacingName(input);
    const toolUseMessage = input ? tool.renderToolUseMessage(input, {
      theme,
      verbose: true
    }) : null;
    t1 = <Box key={content.id} flexDirection="column" marginTop={1} backgroundColor={bg}><Box flexDirection="row">{<ToolUseLoader shouldAnimate={shouldAnimate && isInProgress} isUnresolved={!isResolved} isError={isError} />}<Text><Text bold={true}>{userFacingName}</Text>{toolUseMessage && <Text>({toolUseMessage})</Text>}</Text>{input && tool.renderToolUseTag?.(input)}</Box>{isResolved && !isError && toolResult !== undefined && <Box>{tool.renderToolResultMessage?.(toolResult, [], {
          verbose: true,
          tools,
          theme
        })}</Box>}</Box>;
  }
  if (t2 !== Symbol.for("react.early_return_sentinel")) {
    return t2;
  }
  return t1;
}
export function CollapsedReadSearchContent({
  message,
  inProgressToolUseIDs,
  shouldAnimate,
  verbose,
  tools,
  lookups,
  isActiveGroup
}: Props): React.ReactNode {
  const bg = useSelectedMessageBg();
  const {
    searchCount: rawSearchCount,
    readCount: rawReadCount,
    listCount: rawListCount,
    replCount,
    memorySearchCount,
    memoryReadCount,
    memoryWriteCount,
    messages: groupMessages
  } = message;
  const [theme] = useTheme();
  const toolUseIds = getToolUseIdsFromCollapsedGroup(message);
  const anyError = toolUseIds.some(id => lookups.erroredToolUseIDs.has(id));
  const hasMemoryOps = memorySearchCount > 0 || memoryReadCount > 0 || memoryWriteCount > 0;
  const hasTeamMemoryOps = feature('TEAMMEM') ? teamMemCollapsed!.checkHasTeamMemOps(message) : false;

  // Track the max seen counts so they only ever increase. The debounce timer
  // causes extra re-renders at arbitrary times; during a brief "invisible window"
  // in the streaming executor the group count can dip, which causes jitter.
  const maxReadCountRef = useRef(0);
  const maxSearchCountRef = useRef(0);
  const maxListCountRef = useRef(0);
  const maxMcpCountRef = useRef(0);
  const maxBashCountRef = useRef(0);
  maxReadCountRef.current = Math.max(maxReadCountRef.current, rawReadCount);
  maxSearchCountRef.current = Math.max(maxSearchCountRef.current, rawSearchCount);
  maxListCountRef.current = Math.max(maxListCountRef.current, rawListCount);
  maxMcpCountRef.current = Math.max(maxMcpCountRef.current, message.mcpCallCount ?? 0);
  maxBashCountRef.current = Math.max(maxBashCountRef.current, message.bashCount ?? 0);
  const readCount = maxReadCountRef.current;
  const searchCount = maxSearchCountRef.current;
  const listCount = maxListCountRef.current;
  const mcpCallCount = maxMcpCountRef.current;
  // Subtract commands surfaced as "Committed …" / "Created PR …" so the
  // same command isn't counted twice. gitOpBashCount is read live (no max-ref
  // needed — it's 0 until results arrive, then only grows).
  const gitOpBashCount = message.gitOpBashCount ?? 0;
  const bashCount = isFullscreenEnvEnabled() ? Math.max(0, maxBashCountRef.current - gitOpBashCount) : 0;
  const hasNonMemoryOps = searchCount > 0 || readCount > 0 || listCount > 0 || replCount > 0 || mcpCallCount > 0 || bashCount > 0 || gitOpBashCount > 0;
  const readPaths = message.readFilePaths;
  const searchArgs = message.searchArgs;
  let incomingHint = message.latestDisplayHint;
  if (incomingHint === undefined) {
    const lastSearchRaw = searchArgs?.at(-1);
    const lastSearch = lastSearchRaw !== undefined ? `"${lastSearchRaw}"` : undefined;
    const lastRead = readPaths?.at(-1);
    incomingHint = lastRead !== undefined ? getDisplayPath(lastRead) : lastSearch;
  }

  // Active REPL calls emit repl_tool_call progress with the current inner
  // tool's name+input. Virtual messages don't arrive until REPL completes,
  // so this is the only source of a live hint during execution.
  if (isActiveGroup) {
    for (const id_0 of toolUseIds) {
      if (!inProgressToolUseIDs.has(id_0)) continue;
      const latest = lookups.progressMessagesByToolUseID.get(id_0)?.at(-1)?.data;
      if (latest?.type === 'repl_tool_call' && latest.phase === 'start') {
        const input = latest.toolInput as {
          command?: string;
          pattern?: string;
          file_path?: string;
        };
        incomingHint = input.file_path ?? (input.pattern ? `"${input.pattern}"` : undefined) ?? input.command ?? latest.toolName;
      }
    }
  }
  const displayedHint = useMinDisplayTime(incomingHint, MIN_HINT_DISPLAY_MS);

  // In verbose mode, render each tool use with its 1-line result summary
  if (verbose) {
    const toolUses: NormalizedAssistantMessage[] = [];
    for (const msg of groupMessages) {
      if (msg.type === 'assistant') {
        toolUses.push(msg);
      } else if (msg.type === 'grouped_tool_use') {
        toolUses.push(...msg.messages);
      }
    }
    return <Box flexDirection="column">
        {toolUses.map(msg_0 => {
        const content = msg_0.message.content[0];
        if (content?.type !== 'tool_use') return null;
        return <VerboseToolUse key={content.id} content={content} tools={tools} lookups={lookups} inProgressToolUseIDs={inProgressToolUseIDs} shouldAnimate={shouldAnimate} theme={theme} />;
      })}
        {message.hookInfos && message.hookInfos.length > 0 && <>
            <Text dimColor>
              {'  ⎿  '}Ran {message.hookCount} PreToolUse{' '}
              {message.hookCount === 1 ? 'hook' : 'hooks'} (
              {formatSecondsShort(message.hookTotalMs ?? 0)})
            </Text>
            {message.hookInfos.map((info, idx) => <Text key={`hook-${idx}`} dimColor>
                {'     ⎿ '}
                {info.command} ({formatSecondsShort(info.durationMs ?? 0)})
              </Text>)}
          </>}
        {message.relevantMemories?.map(m => <Box key={m.path} flexDirection="column" marginTop={1}>
            <Text dimColor>
              {'  ⎿  '}Recalled {basename(m.path)}
            </Text>
            <Box paddingLeft={5}>
              <Text>
                <Ansi>{m.content}</Ansi>
              </Text>
            </Box>
          </Box>)}
      </Box>;
  }

  // Non-verbose mode: Show counts with blinking grey dot while active, green dot when finalized
  // Use present tense when active, past tense when finalized

  // Defensive: If all counts are 0, don't render the collapsed group
  // This shouldn't happen in normal operation, but handles edge cases
  if (!hasMemoryOps && !hasTeamMemoryOps && !hasNonMemoryOps) {
    return null;
  }

  // Find the slowest in-progress shell command in this group. BashTool yields
  // progress every second but the collapsed renderer never showed it — long
  // commands (npm install, tests) looked frozen. Shown after 2s so fast
  // commands stay clean; the ticking counter reassures that slow ones aren't stuck.
  let shellProgressSuffix = '';
  if (isFullscreenEnvEnabled() && isActiveGroup) {
    let elapsed: number | undefined;
    let lines = 0;
    for (const id_1 of toolUseIds) {
      if (!inProgressToolUseIDs.has(id_1)) continue;
      const data = lookups.progressMessagesByToolUseID.get(id_1)?.at(-1)?.data;
      if (data?.type !== 'bash_progress' && data?.type !== 'powershell_progress') {
        continue;
      }
      if (elapsed === undefined || data.elapsedTimeSeconds > elapsed) {
        elapsed = data.elapsedTimeSeconds;
        lines = data.totalLines;
      }
    }
    if (elapsed !== undefined && elapsed >= 2) {
      const time = formatDuration(elapsed * 1000);
      const lineUnit = tSync(lines === 1 ? 'summary.line_one' : 'summary.line_other', {
        count: lines
      });
      shellProgressSuffix = lines > 0 ? ` (${time} · ${lines} ${lineUnit})` : ` (${time})`;
    }
  }

  // Build non-memory parts first (search, read, repl, mcp, bash) — these render
  // before memory so the line reads "Ran 3 bash commands, recalled 1 memory".
  const nonMemParts: React.ReactNode[] = [];

  // Git operations lead the line — they're the load-bearing outcome.
  function pushPart(key: string, verbKey: string, body: React.ReactNode): void {
    const isFirst = nonMemParts.length === 0;
    if (!isFirst) nonMemParts.push(<Text key={`comma-${key}`}>, </Text>);
    const verb = tSync(`summary.git.${verbKey}`);
    nonMemParts.push(<Text key={key}>
        {isFirst ? verb[0]!.toUpperCase() + verb.slice(1) : verb} {body}
      </Text>);
  }
  if (isFullscreenEnvEnabled() && message.commits?.length) {
    for (const kind of ['committed', 'amended', 'cherryPicked'] as const) {
      const shas = message.commits.filter(c => c.kind === kind.replace('Picked', '-picked')).map(c_0 => c_0.sha);
      if (shas.length) {
        pushPart(kind, kind, <Text bold>{shas.join(', ')}</Text>);
      }
    }
  }
  if (isFullscreenEnvEnabled() && message.pushes?.length) {
    const branches = uniq(message.pushes.map(p => p.branch));
    pushPart('push', 'pushedTo', <Text bold>{branches.join(', ')}</Text>);
  }
  if (isFullscreenEnvEnabled() && message.branches?.length) {
    for (const b of message.branches) {
      pushPart(`br-${b.action}-${b.ref}`, b.action === 'merged' ? 'merged' : 'rebasedOnto', <Text bold>{b.ref}</Text>);
    }
  }
  if (isFullscreenEnvEnabled() && message.prs?.length) {
    for (const pr of message.prs) {
      const verbKey = pr.action === 'ready' ? 'prMarkedReady' : `pr${pr.action[0]!.toUpperCase()}${pr.action.slice(1)}`;
      pushPart(`pr-${pr.action}-${pr.number}`, verbKey, pr.url ? <PrBadge number={pr.number} url={pr.url} bold /> : <Text bold>PR #{pr.number}</Text>);
    }
  }
  if (searchCount > 0) {
    const isFirst_0 = nonMemParts.length === 0;
    const phase = isActiveGroup ? 'active' : 'done';
    const position = isFirst_0 ? 'first' : 'sub';
    const searchKey = `summary.search.${phase}.${position}`;
    const searchUnit = tSync(searchCount === 1 ? 'summary.search.pattern_one' : 'summary.search.pattern_other', {
      count: searchCount
    });
    if (!isFirst_0) {
      nonMemParts.push(<Text key="comma-s">, </Text>);
    }
    nonMemParts.push(<Text key="search">
        {tSync(searchKey, {
        count: searchCount,
        unit: searchUnit
      })}
      </Text>);
  }
  if (readCount > 0) {
    const isFirst_1 = nonMemParts.length === 0;
    const phase = isActiveGroup ? 'active' : 'done';
    const position = isFirst_1 ? 'first' : 'sub';
    const readKey = `summary.read.${phase}.${position}`;
    const readUnit = tSync(readCount === 1 ? 'summary.read.file_one' : 'summary.read.file_other', {
      count: readCount
    });
    if (!isFirst_1) {
      nonMemParts.push(<Text key="comma-r">, </Text>);
    }
    nonMemParts.push(<Text key="read">
        {tSync(readKey, {
        count: readCount,
        unit: readUnit
      })}
      </Text>);
  }
  if (listCount > 0) {
    const isFirst_2 = nonMemParts.length === 0;
    const phase = isActiveGroup ? 'active' : 'done';
    const position = isFirst_2 ? 'first' : 'sub';
    const listKey = `summary.list.${phase}.${position}`;
    const listUnit = tSync(listCount === 1 ? 'summary.list.directory_one' : 'summary.list.directory_other', {
      count: listCount
    });
    if (!isFirst_2) {
      nonMemParts.push(<Text key="comma-l">, </Text>);
    }
    nonMemParts.push(<Text key="list">
        {tSync(listKey, {
        count: listCount,
        unit: listUnit
      })}
      </Text>);
  }
  if (replCount > 0) {
    const replKey = isActiveGroup ? 'summary.repl.active' : 'summary.repl.done';
    const replUnit = tSync(replCount === 1 ? 'summary.repl.time_one' : 'summary.repl.time_other', {
      count: replCount
    });
    if (nonMemParts.length > 0) {
      nonMemParts.push(<Text key="comma-repl">, </Text>);
    }
    nonMemParts.push(<Text key="repl">
        {tSync(replKey, {
        count: replCount,
        unit: replUnit
      })}
      </Text>);
  }
  if (mcpCallCount > 0) {
    const serverLabel = message.mcpServerNames?.map(n => n.replace(/^zy\.ai /, '')).join(', ') || 'MCP';
    const isFirst_3 = nonMemParts.length === 0;
    const phase = isActiveGroup ? 'active' : 'done';
    const position = isFirst_3 ? 'first' : 'sub';
    const mcpKey = `summary.mcp.${phase}.${position}`;
    if (!isFirst_3) {
      nonMemParts.push(<Text key="comma-mcp">, </Text>);
    }
    nonMemParts.push(<Text key="mcp">
        {tSync(mcpKey, {
        server: serverLabel
      })}
        {mcpCallCount > 1 && <>
            {' '}
            <Text bold>{mcpCallCount}</Text> {tSync('summary.repl.time_other', {
          count: mcpCallCount
        })}
          </>}
      </Text>);
  }
  if (isFullscreenEnvEnabled() && bashCount > 0) {
    const isFirst_4 = nonMemParts.length === 0;
    const phase = isActiveGroup ? 'active' : 'done';
    const position = isFirst_4 ? 'first' : 'sub';
    const bashKey = `summary.bash.${phase}.${position}`;
    const bashUnit = tSync(bashCount === 1 ? 'summary.bash.command_one' : 'summary.bash.command_other', {
      count: bashCount
    });
    if (!isFirst_4) {
      nonMemParts.push(<Text key="comma-bash">, </Text>);
    }
    nonMemParts.push(<Text key="bash">
        {tSync(bashKey, {
        count: bashCount,
        unit: bashUnit
      })}
      </Text>);
  }

  // Build memory parts (auto-memory) — rendered after nonMemParts
  const hasPrecedingNonMem = nonMemParts.length > 0;
  const memParts: React.ReactNode[] = [];
  if (memoryReadCount > 0) {
    const isFirst_5 = !hasPrecedingNonMem && memParts.length === 0;
    const phase = isActiveGroup ? 'active' : 'done';
    const position = isFirst_5 ? 'first' : 'sub';
    const mrKey = `summary.memoryRead.${phase}.${position}`;
    const mrUnit = tSync(memoryReadCount === 1 ? 'summary.memory_one' : 'summary.memory_other', {
      count: memoryReadCount
    });
    if (!isFirst_5) {
      memParts.push(<Text key="comma-mr">, </Text>);
    }
    memParts.push(<Text key="mem-read">
        {tSync(mrKey, {
        count: memoryReadCount,
        unit: mrUnit
      })}
      </Text>);
  }
  if (memorySearchCount > 0) {
    const isFirst_6 = !hasPrecedingNonMem && memParts.length === 0;
    const phase = isActiveGroup ? 'active' : 'done';
    const position = isFirst_6 ? 'first' : 'sub';
    const msKey = `summary.memorySearch.${phase}.${position}`;
    if (!isFirst_6) {
      memParts.push(<Text key="comma-ms">, </Text>);
    }
    memParts.push(<Text key="mem-search">{tSync(msKey)}</Text>);
  }
  if (memoryWriteCount > 0) {
    const isFirst_7 = !hasPrecedingNonMem && memParts.length === 0;
    const phase = isActiveGroup ? 'active' : 'done';
    const position = isFirst_7 ? 'first' : 'sub';
    const mwKey = `summary.memoryWrite.${phase}.${position}`;
    const mwUnit = tSync(memoryWriteCount === 1 ? 'summary.memory_one' : 'summary.memory_other', {
      count: memoryWriteCount
    });
    if (!isFirst_7) {
      memParts.push(<Text key="comma-mw">, </Text>);
    }
    memParts.push(<Text key="mem-write">
        {tSync(mwKey, {
        count: memoryWriteCount,
        unit: mwUnit
      })}
      </Text>);
  }
  return <Box flexDirection="column" marginTop={1} backgroundColor={bg}>
      <Box flexDirection="row">
        {isActiveGroup ? <ToolUseLoader shouldAnimate isUnresolved isError={anyError} /> : <Box minWidth={2} />}
        <Text dimColor={!isActiveGroup}>
          {nonMemParts}
          {memParts}
          {feature('TEAMMEM') ? teamMemCollapsed!.TeamMemCountParts({
          message,
          isActiveGroup,
          hasPrecedingParts: hasPrecedingNonMem || memParts.length > 0
        }) : null}
          {isActiveGroup && <Text key="ellipsis">…</Text>} <CtrlOToExpand />
        </Text>
      </Box>
      {isActiveGroup && displayedHint !== undefined &&
    // Row layout: 5-wide gutter for ⎿, then a flex column for the text.
    // Ink's wrap stays inside the right column so continuation lines
    // indent under ⎿. MAX_HINT_CHARS in commandAsHint caps total at ~5 lines.
    <Box flexDirection="row">
          <Box width={5} flexShrink={0}>
            <Text dimColor>{'  ⎿  '}</Text>
          </Box>
          <Box flexDirection="column" flexGrow={1}>
            {displayedHint.split('\n').map((line, i, arr) => <Text key={`hint-${i}`} dimColor>
                {line}
                {i === arr.length - 1 && shellProgressSuffix}
              </Text>)}
          </Box>
        </Box>}
      {message.hookTotalMs !== undefined && message.hookTotalMs > 0 && <Text dimColor>
          {'  ⎿  '}Ran {message.hookCount} PreToolUse{' '}
          {message.hookCount === 1 ? 'hook' : 'hooks'} (
          {formatSecondsShort(message.hookTotalMs)})
        </Text>}
    </Box>;
}
