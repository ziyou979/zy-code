import type { ToolResultBlockParam, ToolUseBlockParam } from '@anthropic-ai/sdk/resources/index.mjs';
import * as React from 'react';
import { ConfigurableShortcutHint } from 'src/components/ConfigurableShortcutHint.js';
import { CtrlOToExpand, SubAgentProvider } from 'src/components/CtrlOToExpand.js';
import { Byline } from 'src/components/design-system/Byline.js';
import { KeyboardShortcutHint } from 'src/components/design-system/KeyboardShortcutHint.js';
import type { z } from 'zod/v4';
import { AgentProgressLine } from '../../components/AgentProgressLine.js';
import { FallbackToolUseErrorMessage } from '../../components/FallbackToolUseErrorMessage.js';
import { FallbackToolUseRejectedMessage } from '../../components/FallbackToolUseRejectedMessage.js';
import { Markdown } from '../../components/Markdown.js';
import { Message as MessageComponent } from '../../components/Message.js';
import { MessageResponse } from '../../components/MessageResponse.js';
import { ToolUseLoader } from '../../components/ToolUseLoader.js';
import { Box, Text } from '../../ink.js';
import { tSync } from '../../i18n/index.js';
import { getDumpPromptsPath } from '../../services/api/dumpPrompts.js';
import { findToolByName, type Tools } from '../../Tool.js';
import type { Message, ProgressMessage } from '../../types/message.js';
import type { AgentToolProgress } from '../../types/tools.js';
import { count } from '../../utils/array.js';
import { getSearchOrReadFromContent, getSearchReadSummaryText } from '../../utils/collapseReadSearch.js';
import { isInternalBuild } from '../../utils/envUtils.js';
import { getDisplayPath } from '../../utils/file.js';
import { formatDuration, formatNumber } from '../../utils/format.js';
import { buildSubagentLookups, createAssistantMessage, EMPTY_LOOKUPS } from '../../utils/messages.js';
import type { ModelAlias } from '../../utils/model/aliases.js';
import { getMainLoopModel, parseUserSpecifiedModel, renderModelName } from '../../utils/model/model.js';
import type { Theme, ThemeName } from '../../utils/theme.js';
import type { outputSchema, Progress, RemoteLaunchedOutput } from './AgentTool.js';
import { inputSchema } from './AgentTool.js';
import { getAgentColor } from './agentColorManager.js';
import { GENERAL_PURPOSE_AGENT } from './built-in/generalPurposeAgent.js';
const MAX_PROGRESS_MESSAGES_TO_SHOW = 3;

/**
 * 守卫函数：检查 progress 数据是否包含 `message` 字段（agent_progress 或
 * skill_progress）。其他类型的 progress（例如从子代理转发的 bash_progress）
 * 缺少此字段，必须被 UI 助手跳过。
 */
function hasProgressMessage(data: Progress): data is AgentToolProgress {
  if (!('message' in data)) {
    return false;
  }
  const msg = (data as AgentToolProgress).message;
  return msg != null && typeof msg === 'object' && 'type' in msg;
}

/**
 * 检查 progress 消息是否为 search/read/REPL 操作（工具使用或结果）。
 * 如果是可折叠操作，返回 { isSearch, isRead, isREPL }，否则返回 null。
 *
 * 对于 tool_result 消息，使用提供的 `toolUseByID` 映射来查找对应的
 * tool_use 块，而不是依赖 `normalizedMessages`。
 */
function getSearchOrReadInfo(progressMessage: ProgressMessage<Progress>, tools: Tools, toolUseByID: Map<string, ToolUseBlockParam>): {
  isSearch: boolean;
  isRead: boolean;
  isREPL: boolean;
} | null {
  if (!hasProgressMessage(progressMessage.data)) {
    return null;
  }
  const message = progressMessage.data.message;

  // 检查 tool_use（助手消息）
  // @ts-ignore -- message type is narrowed at runtime; AgentToolProgress.message may be assistant after build-time transforms
  if (message.type === 'assistant') {
    return getSearchOrReadFromContent(message.message.content[0], tools);
  }

  // 检查 tool_result（用户消息）- 从映射中查找对应的 tool use
  if (message.type === 'user') {
    const content = message.message.content[0];
    if (content?.type === 'tool_result') {
      const toolUse = toolUseByID.get(content.tool_use_id);
      if (toolUse) {
        return getSearchOrReadFromContent(toolUse, tools);
      }
    }
  }
  return null;
}
type SummaryMessage = {
  type: 'summary';
  searchCount: number;
  readCount: number;
  replCount: number;
  uuid: string;
  isActive: boolean; // true 表示仍在进行中（最后一条消息是 tool_use 而非 tool_result）
};
type ProcessedMessage = {
  type: 'original';
  message: ProgressMessage<AgentToolProgress>;
} | SummaryMessage;

/**
 * 处理 progress 消息，将连续的 search/read 操作分组为摘要。
 * 仅适用于 ant —— 对非 ant 返回原始消息。
 * @param isAgentRunning - 如果为 true，最后一个分组始终标记为活跃（进行中）
 */
function processProgressMessages(messages: ProgressMessage<Progress>[], tools: Tools, isAgentRunning: boolean): ProcessedMessage[] {
  // 仅对 ant 进行处理
  if (!isInternalBuild()) {
    return messages.filter((m): m is ProgressMessage<AgentToolProgress> => hasProgressMessage(m.data) && m.data.message.type !== 'user').map(m => ({
      type: 'original',
      message: m
    }));
  }
  const result: ProcessedMessage[] = [];
  let currentGroup: {
    searchCount: number;
    readCount: number;
    replCount: number;
    startUuid: string;
  } | null = null;
  function flushGroup(isActive: boolean): void {
    if (currentGroup && (currentGroup.searchCount > 0 || currentGroup.readCount > 0 || currentGroup.replCount > 0)) {
      result.push({
        type: 'summary',
        searchCount: currentGroup.searchCount,
        readCount: currentGroup.readCount,
        replCount: currentGroup.replCount,
        uuid: `summary-${currentGroup.startUuid}`,
        isActive
      });
    }
    currentGroup = null;
  }
  const agentMessages = messages.filter((m): m is ProgressMessage<AgentToolProgress> => hasProgressMessage(m.data));

  // 在迭代过程中逐步构建 tool_use 查找表
  const toolUseByID = new Map<string, ToolUseBlockParam>();
  for (const msg of agentMessages) {
    // 跟踪遇到的 tool_use 块
    // @ts-ignore -- message type is narrowed at runtime
    if (msg.data.message.type === 'assistant') {
      for (const c of (msg.data.message as any).message.content) {
        if (c.type === 'tool_use') {
          toolUseByID.set(c.id, c as ToolUseBlockParam);
        }
      }
    }
    const info = getSearchOrReadInfo(msg, tools, toolUseByID);
    if (info && (info.isSearch || info.isRead || info.isREPL)) {
      // 这是一个 search/read/REPL 操作 - 添加到当前分组
      if (!currentGroup) {
        currentGroup = {
          searchCount: 0,
          readCount: 0,
          replCount: 0,
          startUuid: msg.uuid
        };
      }
      // 仅统计 tool_result 消息（不统计 tool_use）以避免重复计数
      if (msg.data.message.type === 'user') {
        if (info.isSearch) {
          currentGroup.searchCount++;
        } else if (info.isREPL) {
          currentGroup.replCount++;
        } else if (info.isRead) {
          currentGroup.readCount++;
        }
      }
    } else {
      // 非 search/read/REPL 消息 - 刷新当前分组（已完成）并添加此消息
      flushGroup(false);
      // 跳过用户 tool_result 消息 — 子代理 progress 消息缺少
      // toolUseResult，因此 UserToolSuccessMessage 返回 null，
      // renderToolUseProgressMessage 中的 height=1 Box 会显示为空白行。
      if (msg.data.message.type !== 'user') {
        result.push({
          type: 'original',
          message: msg
        });
      }
    }
  }

  // 刷新剩余分组 - 如果代理仍在运行则为活跃状态
  flushGroup(isAgentRunning);
  return result;
}
const ESTIMATED_LINES_PER_TOOL = 9;
const TERMINAL_BUFFER_LINES = 7;
type Output = z.input<ReturnType<typeof outputSchema>>;
type AgentPromptDisplayProps = {
  prompt: string;
  dim?: boolean;
  theme?: string;
};
export function AgentPromptDisplay({
  prompt,
}: AgentPromptDisplayProps) {
  return <Box flexDirection="column">{<Text color="success" bold={true}>Prompt:</Text>}<Box paddingLeft={2}><Markdown>{prompt}</Markdown></Box></Box>;
}
type AgentResponseDisplayProps = {
  content: Array<{ text: string }>;
  theme?: string;
};
export function AgentResponseDisplay({
  content
}: AgentResponseDisplayProps) {
  const responseBlocks = content.map((block, index) => <Box key={index} paddingLeft={2} marginTop={index === 0 ? 0 : 1}><Markdown>{block.text}</Markdown></Box>);
  return <Box flexDirection="column">{<Text color="success" bold={true}>Response:</Text>}{responseBlocks}</Box>;
}
type VerboseAgentTranscriptProps = {
  progressMessages: ProgressMessage<Progress>[];
  tools: Tools;
  verbose: boolean;
};
function VerboseAgentTranscript({
  progressMessages,
  tools,
  verbose
}: VerboseAgentTranscriptProps) {
  const {
    lookups: agentLookups,
    inProgressToolUseIDs
  // @ts-ignore -- Progress union type narrowed by hasProgressMessage filter
  } = buildSubagentLookups(progressMessages.filter(pm => hasProgressMessage(pm.data)).map(pm_0 => pm_0.data));
  const filteredMessages = progressMessages.filter(pm_1 => {
    if (!hasProgressMessage(pm_1.data)) {
      return false;
    }
    const msg = pm_1.data.message;
    if (msg.type === "user" && msg.toolUseResult === undefined) {
      return false;
    }
    return true;
  });
  // @ts-ignore -- Progress type narrowed by filter above
  const transcriptElements = filteredMessages.map(progressMessage => <MessageResponse key={progressMessage.uuid} height={1}><MessageComponent message={progressMessage.data.message} lookups={agentLookups} addMargin={false} tools={tools} commands={[]} verbose={verbose} inProgressToolUseIDs={inProgressToolUseIDs} progressMessagesForMessage={[]} shouldAnimate={false} shouldShowDot={false} isTranscriptMode={false} isStatic={true} /></MessageResponse>);
  return <>{transcriptElements}</>;
}
export function renderToolResultMessage(data: Output, progressMessagesForMessage: ProgressMessage<Progress>[], {
  tools,
  verbose,
  theme,
  isTranscriptMode = false
}: {
  tools: Tools;
  verbose: boolean;
  theme: ThemeName;
  isTranscriptMode?: boolean;
}): React.ReactNode {
  // 远程启动的代理（仅限 ant）使用公共 schema 中不存在的内部输出类型。通过内部判别式进行 narrowing。
  const internal = data as Output | RemoteLaunchedOutput;
  if (internal.status === 'remote_launched') {
    return <Box flexDirection="column">
        <MessageResponse height={1}>
          <Text>
            {tSync('agent.remoteLaunched')}{' '}
            <Text dimColor>
              · {internal.taskId} · {internal.sessionUrl}
            </Text>
          </Text>
        </MessageResponse>
      </Box>;
  }
  if (data.status === 'async_launched') {
    const {
      prompt
    } = data;
    return <Box flexDirection="column">
        <MessageResponse height={1}>
          <Text>
            {tSync('agent.backgrounded')}
            {!isTranscriptMode && <Text dimColor>
                {' ('}
                <Byline>
                  <KeyboardShortcutHint shortcut="↓" action="manage" />
                  {prompt && <ConfigurableShortcutHint action="app:toggleTranscript" context="Global" fallback="ctrl+o" description="expand" />}
                </Byline>
                {')'}
              </Text>}
          </Text>
        </MessageResponse>
        {isTranscriptMode && prompt && <MessageResponse>
            <AgentPromptDisplay prompt={prompt} theme={theme} />
          </MessageResponse>}
      </Box>;
  }
  if (data.status !== 'completed') {
    return null;
  }
  const {
    agentId,
    totalDurationMs,
    totalToolUseCount,
    totalTokens,
    usage,
    content,
    prompt
  } = data;
  const result = [totalToolUseCount === 1 ? '1 tool use' : `${totalToolUseCount} tool uses`, formatNumber(totalTokens) + ' tokens', formatDuration(totalDurationMs)];
  const completionMessage = `Done (${result.join(' · ')})`;
  const finalAssistantMessage = createAssistantMessage({
    content: completionMessage,
    usage: {
      ...usage,
      inference_geo: null,
      iterations: null,
      speed: null
    } as any
  });
  return <Box flexDirection="column">
      {isInternalBuild() && <MessageResponse>
          <Text color="warning">
            {tSync('agent.apiCallsOnly', { path: getDisplayPath(getDumpPromptsPath(agentId)) })}
          </Text>
        </MessageResponse>}
      {isTranscriptMode && prompt && <MessageResponse>
          <AgentPromptDisplay prompt={prompt} theme={theme} />
        </MessageResponse>}
      {isTranscriptMode ? <SubAgentProvider>
          <VerboseAgentTranscript progressMessages={progressMessagesForMessage} tools={tools} verbose={verbose} />
        </SubAgentProvider> : null}
      {isTranscriptMode && content && content.length > 0 && <MessageResponse>
          <AgentResponseDisplay content={content} theme={theme} />
        </MessageResponse>}
      <MessageResponse height={1}>
        <MessageComponent message={finalAssistantMessage} lookups={EMPTY_LOOKUPS} addMargin={false} tools={tools} commands={[]} verbose={verbose} inProgressToolUseIDs={new Set()} progressMessagesForMessage={[]} shouldAnimate={false} shouldShowDot={false} isTranscriptMode={false} isStatic={true} />
      </MessageResponse>
      {!isTranscriptMode && <Text dimColor>
          {'  '}
          <CtrlOToExpand />
        </Text>}
    </Box>;
}
export function renderToolUseMessage({
  description,
  prompt
}: Partial<{
  description: string;
  prompt: string;
}>): React.ReactNode {
  if (!description || !prompt) {
    return null;
  }
  return description;
}
export function renderToolUseTag(input: Partial<{
  description: string;
  prompt: string;
  subagent_type: string;
  model?: ModelAlias;
}>): React.ReactNode {
  const tags: React.ReactNode[] = [];
  if (input.model) {
    const mainModel = getMainLoopModel();
    const agentModel = parseUserSpecifiedModel(input.model);
    if (agentModel !== mainModel) {
      tags.push(<Box key="model" flexWrap="nowrap" marginLeft={1}>
          <Text dimColor>{renderModelName(agentModel)}</Text>
        </Box>);
    }
  }
  if (tags.length === 0) {
    return null;
  }
  return <>{tags}</>;
}
const INITIALIZING_TEXT = 'Initializing…';
export function renderToolUseProgressMessage(progressMessages: ProgressMessage<Progress>[], {
  tools,
  verbose,
  terminalSize,
  inProgressToolCallCount,
  isTranscriptMode = false
}: {
  tools: Tools;
  verbose: boolean;
  terminalSize?: {
    columns: number;
    rows: number;
  };
  inProgressToolCallCount?: number;
  isTranscriptMode?: boolean;
}): React.ReactNode {
  if (!progressMessages.length) {
    return <MessageResponse height={1}>
        <Text dimColor>{INITIALIZING_TEXT}</Text>
      </MessageResponse>;
  }

  // 检查是否应该显示超级精简的 progress 消息摘要。
  // 这可以防止终端尺寸太小无法渲染所有动态内容时出现的闪烁。
  const toolToolRenderLinesEstimate = (inProgressToolCallCount ?? 1) * ESTIMATED_LINES_PER_TOOL + TERMINAL_BUFFER_LINES;
  const shouldUseCondensedMode = !isTranscriptMode && terminalSize && terminalSize.rows && terminalSize.rows < toolToolRenderLinesEstimate;
  const getProgressStats = () => {
    const toolUseCount = count(progressMessages, msg => {
      if (!hasProgressMessage(msg.data)) {
        return false;
      }
      const message = msg.data.message;
      return message.message.content.some(content => content.type === 'tool_use');
    });
    // @ts-ignore -- message type is narrowed at runtime
    const latestAssistant = progressMessages.findLast((msg): msg is ProgressMessage<AgentToolProgress> => hasProgressMessage(msg.data) && msg.data.message.type === 'assistant');
    let tokens = null;
    // @ts-ignore -- message type is narrowed at runtime
    if (latestAssistant?.data.message.type === 'assistant') {
      const usage = (latestAssistant.data.message as any).message.usage;
      tokens = (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + usage.input_tokens + usage.output_tokens;
    }
    return {
      toolUseCount,
      tokens
    };
  };
  if (shouldUseCondensedMode) {
    const {
      toolUseCount,
      tokens
    } = getProgressStats();
    return <MessageResponse height={1}>
        <Text dimColor>
          {tSync('agent.inProgress')}… · <Text bold>{toolUseCount}</Text> {tSync(toolUseCount === 1 ? 'agent.toolUse_one' : 'agent.toolUse_other', { count: toolUseCount })}
          {tokens && ` · ${formatNumber(tokens)} tokens`} ·{' '}
          <ConfigurableShortcutHint action="app:toggleTranscript" context="Global" fallback="ctrl+o" description="expand" parens />
        </Text>
      </MessageResponse>;
  }

  // 处理消息，将连续的 search/read 操作分组为摘要（仅 ant）
  // isAgentRunning=true 因为这是代理仍在运行时显示的 progress 视图
  const processedMessages = processProgressMessages(progressMessages, tools, true);

  // 用于显示，取最后几条处理后的消息
  const displayedMessages = isTranscriptMode ? processedMessages : processedMessages.slice(-MAX_PROGRESS_MESSAGES_TO_SHOW);

  // 专门统计隐藏的工具使用次数（而不是所有消息），以匹配最终的
  // "Done (N tool uses)" 计数。每个工具使用会生成多条 progress 消息
  //（tool_use + tool_result + text），因此统计所有隐藏消息会导致
  // 向用户显示的数字膨胀。
  const hiddenMessages = isTranscriptMode ? [] : processedMessages.slice(0, Math.max(0, processedMessages.length - MAX_PROGRESS_MESSAGES_TO_SHOW));
  const hiddenToolUseCount = count(hiddenMessages, m => {
    if (m.type === 'summary') {
      return m.searchCount + m.readCount + m.replCount > 0;
    }
    const data = m.message.data;
    if (!hasProgressMessage(data)) {
      return false;
    }
    return data.message.message.content.some(content => content.type === 'tool_use');
  });
  const firstData = progressMessages[0]?.data;
  const prompt = firstData && hasProgressMessage(firstData) ? firstData.prompt : undefined;

  // 分组后，当唯一 progress 是 search/read 操作的 assistant tool_use 时
  //（已分组但尚未计数，因为计数在 tool_result 时才增加），
  // displayedMessages 可能为空。回退到初始化文本，
  // 这样 MessageResponse 不会渲染空的 ⎿。
  if (displayedMessages.length === 0 && !(isTranscriptMode && prompt)) {
    return <MessageResponse height={1}>
        <Text dimColor>{INITIALIZING_TEXT}</Text>
      </MessageResponse>;
  }
  const {
    lookups: subagentLookups,
    inProgressToolUseIDs: collapsedInProgressIDs
  } = buildSubagentLookups(progressMessages.filter((pm): pm is ProgressMessage<AgentToolProgress> => hasProgressMessage(pm.data)).map(pm => pm.data));
  return <MessageResponse>
      <Box flexDirection="column">
        <SubAgentProvider>
          {isTranscriptMode && prompt && <Box marginBottom={1}>
              <AgentPromptDisplay prompt={prompt} />
            </Box>}
          {displayedMessages.map(processed => {
          if (processed.type === 'summary') {
            // 使用共享格式渲染分组 search/read/REPL 操作的摘要
            const summaryText = getSearchReadSummaryText(processed.searchCount, processed.readCount, processed.isActive, processed.replCount);
            return <Box key={processed.uuid} height={1} overflow="hidden">
                  <Text dimColor>{summaryText}</Text>
                </Box>;
          }
          // 渲染原始消息，不使用 height=1 包装，这样 null
          // 内容（找不到工具，renderToolUseMessage 返回 null）
          // 不会留下空白行。工具调用头部是单行的，
          // 因此不需要截断。
          return <MessageComponent key={processed.message.uuid} message={processed.message.data.message} lookups={subagentLookups} addMargin={false} tools={tools} commands={[]} verbose={verbose} inProgressToolUseIDs={collapsedInProgressIDs} progressMessagesForMessage={[]} shouldAnimate={false} shouldShowDot={false} style="condensed" isTranscriptMode={false} isStatic={true} />;
        })}
        </SubAgentProvider>
        {hiddenToolUseCount > 0 && <Text dimColor>
            {tSync(hiddenToolUseCount === 1 ? 'agent.moreToolUses_one' : 'agent.moreToolUses_other', { count: hiddenToolUseCount })} <CtrlOToExpand />
          </Text>}
      </Box>
    </MessageResponse>;
}
export function renderToolUseRejectedMessage(_input: {
  description: string;
  prompt: string;
  subagent_type: string;
}, {
  progressMessagesForMessage,
  tools,
  verbose,
  isTranscriptMode
}: {
  columns: number;
  messages: Message[];
  style?: 'condensed';
  theme: ThemeName;
  progressMessagesForMessage: ProgressMessage<Progress>[];
  tools: Tools;
  verbose: boolean;
  isTranscriptMode?: boolean;
}): React.ReactNode {
  // 从 progress 消息中获取 agentId（如果可用，代理在被拒绝前正在运行）
  const firstData = progressMessagesForMessage[0]?.data;
  const agentId = firstData && hasProgressMessage(firstData) ? firstData.agentId : undefined;
  return <>
      {isInternalBuild() && agentId && <MessageResponse>
          <Text color="warning">
            {tSync('agent.apiCallsOnly', { path: getDisplayPath(getDumpPromptsPath(agentId)) })}
          </Text>
        </MessageResponse>}
      {renderToolUseProgressMessage(progressMessagesForMessage, {
      tools,
      verbose,
      isTranscriptMode
    })}
      <FallbackToolUseRejectedMessage />
    </>;
}
export function renderToolUseErrorMessage(result: ToolResultBlockParam['content'], {
  progressMessagesForMessage,
  tools,
  verbose,
  isTranscriptMode
}: {
  progressMessagesForMessage: ProgressMessage<Progress>[];
  tools: Tools;
  verbose: boolean;
  isTranscriptMode?: boolean;
}): React.ReactNode {
  return <>
      {renderToolUseProgressMessage(progressMessagesForMessage, {
      tools,
      verbose,
      isTranscriptMode
    })}
      <FallbackToolUseErrorMessage result={result} verbose={verbose} />
    </>;
}
function calculateAgentStats(progressMessages: ProgressMessage<Progress>[]): {
  toolUseCount: number;
  tokens: number | null;
} {
  const toolUseCount = count(progressMessages, msg => {
    if (!hasProgressMessage(msg.data)) {
      return false;
    }
    const message = msg.data.message;
    return message.type === 'user' && message.message.content.some(content => content.type === 'tool_result');
  });
  // @ts-ignore -- message type is narrowed at runtime
  const latestAssistant = progressMessages.findLast((msg): msg is ProgressMessage<AgentToolProgress> => hasProgressMessage(msg.data) && msg.data.message.type === 'assistant');
  let tokens = null;
  // @ts-ignore -- message type is narrowed at runtime
  if (latestAssistant?.data.message.type === 'assistant') {
    const usage = (latestAssistant.data.message as any).message.usage;
    tokens = (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + usage.input_tokens + usage.output_tokens;
  }
  return {
    toolUseCount,
    tokens
  };
}
export function renderGroupedAgentToolUse(toolUses: Array<{
  param: ToolUseBlockParam;
  isResolved: boolean;
  isError: boolean;
  isInProgress: boolean;
  progressMessages: ProgressMessage<Progress>[];
  result?: {
    param: ToolResultBlockParam;
    output: Output;
  };
}>, options: {
  shouldAnimate: boolean;
  tools: Tools;
}): React.ReactNode | null {
  const {
    shouldAnimate,
    tools
  } = options;

  // 计算每个代理的统计数据
  const agentStats = toolUses.map(({
    param,
    isResolved,
    isError,
    progressMessages,
    result
  }) => {
    const stats = calculateAgentStats(progressMessages);
    const lastToolInfo = extractLastToolInfo(progressMessages, tools);
    const parsedInput = inputSchema().safeParse(param.input);

    // teammate_spawned 不在导出的 Output 类型中（通过 unknown 进行类型转换
    // 以便死代码消除），因此对原始值进行字符串比较来检查
    const isTeammateSpawn = result?.output?.status as string === 'teammate_spawned';

    // 对于 teammate 生成，显示 @name 并在括号中显示类型，描述作为状态
    let agentType: string;
    let description: string | undefined;
    let color: keyof Theme | undefined;
    let descriptionColor: keyof Theme | undefined;
    let taskDescription: string | undefined;
    if (isTeammateSpawn && parsedInput.success && parsedInput.data.name) {
      agentType = `@${parsedInput.data.name}`;
      const subagentType = parsedInput.data.subagent_type;
      description = isCustomSubagentType(subagentType) ? subagentType : undefined;
      taskDescription = parsedInput.data.description;
      // 在类型上使用自定义代理定义的颜色，而不是名称
      descriptionColor = isCustomSubagentType(subagentType) ? getAgentColor(subagentType) as keyof Theme | undefined : undefined;
    } else {
      agentType = parsedInput.success ? userFacingName(parsedInput.data) : 'Agent';
      description = parsedInput.success ? parsedInput.data.description : undefined;
      color = parsedInput.success ? userFacingNameBackgroundColor(parsedInput.data) : undefined;
      taskDescription = undefined;
    }

    // 检查这是否作为后台代理启动，还是在执行过程中被后台化
    const launchedAsAsync = parsedInput.success && 'run_in_background' in parsedInput.data && parsedInput.data.run_in_background === true;
    const outputStatus = (result?.output as {
      status?: string;
    } | undefined)?.status;
    const backgroundedMidExecution = outputStatus === 'async_launched' || outputStatus === 'remote_launched';
    const isAsync = launchedAsAsync || backgroundedMidExecution || isTeammateSpawn;
    const name = parsedInput.success ? parsedInput.data.name : undefined;
    return {
      id: param.id,
      agentType,
      description,
      toolUseCount: stats.toolUseCount,
      tokens: stats.tokens,
      isResolved,
      isError,
      isAsync,
      color,
      descriptionColor,
      lastToolInfo,
      taskDescription,
      name
    };
  });
  const anyUnresolved = toolUses.some(t => !t.isResolved);
  const anyError = toolUses.some(t => t.isError);
  const allComplete = !anyUnresolved;

  // 检查所有代理是否为同一类型
  const allSameType = agentStats.length > 0 && agentStats.every(stat => stat.agentType === agentStats[0]?.agentType);
  const commonType = allSameType && agentStats[0]?.agentType !== 'Agent' ? agentStats[0]?.agentType : null;

  // 检查所有已完成的代理是否都是异步（后台）的
  const allAsync = agentStats.every(stat => stat.isAsync);
  return <Box flexDirection="column" marginTop={1}>
      <Box flexDirection="row">
        <ToolUseLoader shouldAnimate={shouldAnimate && anyUnresolved} isUnresolved={anyUnresolved} isError={anyError} />
        <Text>
          {allComplete ? allAsync ? <>
                <Text bold>{toolUses.length}</Text> {tSync('agent.backgroundAgentsLaunched', { count: toolUses.length })}{' '}
                <Text dimColor>
                  <KeyboardShortcutHint shortcut="↓" action="manage" parens />
                </Text>
              </> : <>
                <Text bold>{toolUses.length}</Text>{' '}
                {commonType ? tSync('agent.agentsFinished', { count: toolUses.length, type: `${commonType} agents` }) : tSync('agent.agentsFinishedNoType', { count: toolUses.length })}
              </> : <>
              {tSync('agent.runningPrefix')} <Text bold>{toolUses.length}</Text>{' '}
              {commonType ? tSync('agent.runningAgents', { count: toolUses.length, type: `${commonType} agents` }) : tSync('agent.runningAgentsNoType', { count: toolUses.length })}
            </>}{' '}
        </Text>
        {!allAsync && <CtrlOToExpand />}
      </Box>
      {agentStats.map((stat, index) => <AgentProgressLine key={stat.id} agentType={stat.agentType} description={stat.description} descriptionColor={stat.descriptionColor} taskDescription={stat.taskDescription} toolUseCount={stat.toolUseCount} tokens={stat.tokens} color={stat.color} isLast={index === agentStats.length - 1} isResolved={stat.isResolved} isError={stat.isError} isAsync={stat.isAsync} shouldAnimate={shouldAnimate} lastToolInfo={stat.lastToolInfo} hideType={allSameType} name={stat.name} />)}
    </Box>;
}
export function userFacingName(input: Partial<{
  description: string;
  prompt: string;
  subagent_type: string;
  name: string;
  team_name: string;
}> | undefined): string {
  if (input?.subagent_type && input.subagent_type !== GENERAL_PURPOSE_AGENT.agentType) {
    // 将 "worker" 代理显示为 "Agent"，使 UI 更简洁
    if (input.subagent_type === 'worker') {
      return 'Agent';
    }
    return input.subagent_type;
  }
  return 'Agent';
}
export function userFacingNameBackgroundColor(input: Partial<{
  description: string;
  prompt: string;
  subagent_type: string;
}> | undefined): keyof Theme | undefined {
  if (!input?.subagent_type) {
    return undefined;
  }

  // 获取此代理的颜色
  return getAgentColor(input.subagent_type) as keyof Theme | undefined;
}
export function extractLastToolInfo(progressMessages: ProgressMessage<Progress>[], tools: Tools): string | null {
  // 从所有 progress 消息中构建 tool_use 查找表（反向迭代需要）
  const toolUseByID = new Map<string, ToolUseBlockParam>();
  for (const pm of progressMessages) {
    if (!hasProgressMessage(pm.data)) {
      continue;
    }
    // @ts-ignore -- message type is narrowed at runtime
    if (pm.data.message.type === 'assistant') {
      for (const c of (pm.data.message as any).message.content) {
        if (c.type === 'tool_use') {
          toolUseByID.set(c.id, c as ToolUseBlockParam);
        }
      }
    }
  }

  // 从末尾开始统计连续的 search/read 操作
  let searchCount = 0;
  let readCount = 0;
  for (let i = progressMessages.length - 1; i >= 0; i--) {
    const msg = progressMessages[i]!;
    if (!hasProgressMessage(msg.data)) {
      continue;
    }
    const info = getSearchOrReadInfo(msg, tools, toolUseByID);
    if (info && (info.isSearch || info.isRead)) {
      // 仅统计 tool_result 消息以避免重复计数
      if (msg.data.message.type === 'user') {
        if (info.isSearch) {
          searchCount++;
        } else if (info.isRead) {
          readCount++;
        }
      }
    } else {
      break;
    }
  }
  if (searchCount + readCount >= 2) {
    return getSearchReadSummaryText(searchCount, readCount, true);
  }

  // 查找最后一条 tool_result 消息
  const lastToolResult = progressMessages.findLast((msg): msg is ProgressMessage<AgentToolProgress> => {
    if (!hasProgressMessage(msg.data)) {
      return false;
    }
    const message = msg.data.message;
    return message.type === 'user' && message.message.content.some(c => c.type === 'tool_result');
  });
  if (lastToolResult?.data.message.type === 'user') {
    const toolResultBlock = lastToolResult.data.message.message.content.find(c => c.type === 'tool_result');
    if (toolResultBlock?.type === 'tool_result') {
      // 查找对应的 tool_use — 已在上面索引
      const toolUseBlock = toolUseByID.get(toolResultBlock.tool_use_id);
      if (toolUseBlock) {
        const tool = findToolByName(tools, toolUseBlock.name);
        if (!tool) {
          return toolUseBlock.name; // 回退到原始名称
        }
        const input = toolUseBlock.input as Record<string, unknown>;
        const parsedInput = tool.inputSchema.safeParse(input);

        // 获取面向用户的工具名称
        const userFacingToolName = tool.userFacingName(parsedInput.success ? parsedInput.data : undefined);

        // 尝试从工具本身获取摘要
        if (tool.getToolUseSummary) {
          const summary = tool.getToolUseSummary(parsedInput.success ? parsedInput.data : undefined);
          if (summary) {
            return `${userFacingToolName}: ${summary}`;
          }
        }

        // 默认值：仅显示面向用户的工具名称
        return userFacingToolName;
      }
    }
  }
  return null;
}
function isCustomSubagentType(subagentType: string | undefined): subagentType is string {
  return !!subagentType && subagentType !== GENERAL_PURPOSE_AGENT.agentType && subagentType !== 'worker';
}
