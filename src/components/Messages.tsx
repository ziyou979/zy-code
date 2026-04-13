import { feature } from 'bun:bundle';
import chalk from 'chalk';
import type { UUID } from 'crypto';
import type { RefObject } from 'react';
import * as React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { every } from 'src/utils/set.js';
import { getIsRemoteMode } from '../bootstrap/state.js';
import type { Command } from '../commands.js';
import { BLACK_CIRCLE } from '../constants/figures.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';
import type { ScrollBoxHandle } from '../ink/components/ScrollBox.js';
import { useTerminalNotification } from '../ink/useTerminalNotification.js';
import { Box, Text } from '../ink.js';
import { useShortcutDisplay } from '../keybindings/useShortcutDisplay.js';
import type { Screen } from '../screens/REPL.js';
import type { Tools } from '../Tool.js';
import { findToolByName } from '../Tool.js';
import type { AgentDefinitionsResult } from '../tools/AgentTool/loadAgentsDir.js';
import type { Message as MessageType, NormalizedMessage, ProgressMessage as ProgressMessageType, RenderableMessage } from '../types/message.js';
import { type AdvisorBlock, isAdvisorBlock } from '../utils/advisor.js';
import { collapseBackgroundBashNotifications } from '../utils/collapseBackgroundBashNotifications.js';
import { collapseHookSummaries } from '../utils/collapseHookSummaries.js';
import { collapseReadSearchGroups } from '../utils/collapseReadSearch.js';
import { collapseTeammateShutdowns } from '../utils/collapseTeammateShutdowns.js';
import { getGlobalConfig } from '../utils/config.js';
import { isEnvTruthy } from '../utils/envUtils.js';
import { isFullscreenEnvEnabled } from '../utils/fullscreen.js';
import { applyGrouping } from '../utils/groupToolUses.js';
import { buildMessageLookups, createAssistantMessage, deriveUUID, getMessagesAfterCompactBoundary, getToolUseID, getToolUseIDs, hasUnresolvedHooksFromLookup, isNotEmptyMessage, normalizeMessages, reorderMessagesInUI, type StreamingThinking, type StreamingToolUse, shouldShowUserMessage } from '../utils/messages.js';
import { plural } from '../utils/stringUtils.js';
import { renderableSearchText } from '../utils/transcriptSearch.js';
import { Divider } from './design-system/Divider.js';
import type { UnseenDivider } from './FullscreenLayout.js';
import { LogoV2 } from './LogoV2/LogoV2.js';
import { StreamingMarkdown } from './Markdown.js';
import { hasContentAfterIndex, MessageRow } from './MessageRow.js';
import { InVirtualListContext, type MessageActionsNav, MessageActionsSelectedContext, type MessageActionsState } from './messageActions.js';
import { AssistantThinkingMessage } from './messages/AssistantThinkingMessage.js';
import { isNullRenderingAttachment } from './messages/nullRenderingAttachments.js';
import { OffscreenFreeze } from './OffscreenFreeze.js';
import type { ToolUseConfirm } from './permissions/PermissionRequest.js';
import { StatusNotices } from './StatusNotices.js';
import type { JumpHandle } from './VirtualMessageList.js';

// 经过 memo 的 logo header：该 box 是主屏幕模式下所有 MessageRows
// 之前的第一个兄弟节点。如果它在每次 Messages 重新渲染时都变脏，
// renderChildren 的 seenDirtyChild 级联会为所有后续兄弟节点禁用
// prevScreen（blit）——每条 MessageRow 都从头重新写入而不是 blit。
// 在长会话中（约 2800 条消息），这会导致每帧 150K+ 次写入并将
// CPU 占用推到 100%。memo 依赖 agentDefinitions，这样新的 messages
// 数组不会使 logo 子树失效。LogoV2/StatusNotices 内部会订阅
// useAppState/useSettings 来获取自己的更新。
const LogoHeader = React.memo(function LogoHeader({
  agentDefinitions
}) {
  return <OffscreenFreeze><Box flexDirection="column" gap={1}>{<LogoV2 />}<React.Suspense fallback={null}><StatusNotices agentDefinitions={agentDefinitions} /></React.Suspense></Box></OffscreenFreeze>;
});

// 死代码消除：proactive 模式的条件导入
/* eslint-disable @typescript-eslint/no-require-imports */
const proactiveModule = feature('PROACTIVE') || feature('KAIROS') ? require('../proactive/index.js') : null;
const BRIEF_TOOL_NAME: string | null = feature('KAIROS') || feature('KAIROS_BRIEF') ? (require('../tools/BriefTool/prompt.js') as typeof import('../tools/BriefTool/prompt.js')).BRIEF_TOOL_NAME : null;
const SEND_USER_FILE_TOOL_NAME: string | null = feature('KAIROS') ? (require('../tools/SendUserFileTool/prompt.js') as typeof import('../tools/SendUserFileTool/prompt.js')).SEND_USER_FILE_TOOL_NAME : null;

/* eslint-enable @typescript-eslint/no-require-imports */
import { VirtualMessageList } from './VirtualMessageList.js';

/**
 * 在 brief-only 模式下，仅过滤出 Brief tool_use 块、
 * 对应的 tool_result 以及真实的用户输入。所有 assistant 文本都会被丢弃——
 * 如果模型忘记调用 Brief，用户在该 turn 中将看不到任何内容。
 * 这是模型需要正确处理的事情；过滤器不会对此做二次判断。
 */
export function filterForBriefTool<T extends {
  type: string;
  subtype?: string;
  isMeta?: boolean;
  isApiErrorMessage?: boolean;
  message?: {
    content: Array<{
      type: string;
      name?: string;
      tool_use_id?: string;
    }>;
  };
  attachment?: {
    type: string;
    isMeta?: boolean;
    origin?: unknown;
    commandMode?: string;
  };
}>(messages: T[], briefToolNames: string[]): T[] {
  const nameSet = new Set(briefToolNames);
  // tool_use always precedes its tool_result in the array, so we can collect
  // IDs and match against them in a single pass.
  const briefToolUseIDs = new Set<string>();
  return messages.filter(msg => {
    // System 消息（附件确认、远程错误、compact boundary）
    // 必须保持可见——丢弃它们会让用户看不到任何反馈。
    // 例外：api_metrics 是每个 turn 的调试噪声（TTFT、配置写入、
    // hook 计时），会破坏 brief 模式的意义。在 transcript 模式下仍然可见
    // （ctrl+o），因为它会绕过此过滤器。
    if (msg.type === 'system') return msg.subtype !== 'api_metrics';
    const block = msg.message?.content[0];
    if (msg.type === 'assistant') {
      // API 错误消息（认证失败、限流等）必须保持可见
      if (msg.isApiErrorMessage) return true;
      // 保留 Brief tool_use 块（使用标准 tool call 样式渲染，
      // 并且必须在列表中以便 buildMessageLookups 可以解析 tool result）
      if (block?.type === 'tool_use' && block.name && nameSet.has(block.name)) {
        if ('id' in block) {
          briefToolUseIDs.add((block as {
            id: string;
          }).id);
        }
        return true;
      }
      return false;
    }
    if (msg.type === 'user') {
      if (block?.type === 'tool_result') {
        return block.tool_use_id !== undefined && briefToolUseIDs.has(block.tool_use_id);
      }
      // 仅保留真实的用户输入——丢弃 meta/tick 消息。
      return !msg.isMeta;
    }
    if (msg.type === 'attachment') {
      // 用户在 turn 中间输入的内容会作为 queued_command attachment 到达
      // （query.ts 中链 drain → getQueuedCommandAttachments）。保留它——
      // 这是用户输入的内容。commandMode === 'prompt' 正面标识了人工输入；
      // task-notification 调用方会设置 mode: 'task-notification' 但不会设置
      // origin/isMeta，所以必须用正面的 commandMode 检查来排除它们。
      const att = msg.attachment;
      return att?.type === 'queued_command' && att.commandMode === 'prompt' && !att.isMeta && att.origin === undefined;
    }
    return false;
  });
}

/**
 * filterForBriefTool 的完整 transcript 配套函数。当使用 Brief tool 时，
 * 模型的文本输出与紧随其后写入的 SendUserMessage 内容是冗余的——
 * 丢弃文本，这样只显示 SendUserMessage 块。Tool call 和它们的 result 保持可见。
 *
 * 按 turn 处理：仅在调用了 Brief 的 turn 中丢弃文本。如果模型忘记了，
 * 文本仍然会显示——否则用户将看不到任何内容。
 */
export function dropTextInBriefTurns<T extends {
  type: string;
  isMeta?: boolean;
  message?: {
    content: Array<{
      type: string;
      name?: string;
    }>;
  };
}>(messages: T[], briefToolNames: string[]): T[] {
  const nameSet = new Set(briefToolNames);
  // 第一遍：查找哪些 turn（由非 meta 用户消息界定）包含 Brief tool_use。
  // 为每个 assistant 文本块标记其 turn index。
  const turnsWithBrief = new Set<number>();
  const textIndexToTurn: number[] = [];
  let turn = 0;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    const block = msg.message?.content[0];
    if (msg.type === 'user' && block?.type !== 'tool_result' && !msg.isMeta) {
      turn++;
      continue;
    }
    if (msg.type === 'assistant') {
      if (block?.type === 'text') {
        textIndexToTurn[i] = turn;
      } else if (block?.type === 'tool_use' && block.name && nameSet.has(block.name)) {
        turnsWithBrief.add(turn);
      }
    }
  }
  if (turnsWithBrief.size === 0) return messages;
  // 第二遍：丢弃调用了 Brief 的 turn 中的文本块。
  return messages.filter((_, i) => {
    const t = textIndexToTurn[i];
    return t === undefined || !turnsWithBrief.has(t);
  });
}
type Props = {
  messages: MessageType[];
  tools: Tools;
  commands: Command[];
  verbose: boolean;
  toolJSX: {
    jsx: React.ReactNode | null;
    shouldHidePromptInput: boolean;
    shouldContinueAnimation?: true;
  } | null;
  toolUseConfirmQueue: ToolUseConfirm[];
  inProgressToolUseIDs: Set<string>;
  isMessageSelectorVisible: boolean;
  conversationId: string;
  screen: Screen;
  streamingToolUses: StreamingToolUse[];
  showAllInTranscript?: boolean;
  agentDefinitions?: AgentDefinitionsResult;
  onOpenRateLimitOptions?: () => void;
  /** 隐藏 logo/header——用于子代理缩放视图 */
  hideLogo?: boolean;
  isLoading: boolean;
  /** 在 transcript 模式下，隐藏除最后一个之外的所有 thinking 块 */
  hidePastThinking?: boolean;
  /** Streaming thinking 内容（实时更新，非冻结） */
  streamingThinking?: StreamingThinking | null;
  /** Streaming text 预览（作为最后一项渲染，以便过渡到最终消息时位置无缝衔接） */
  streamingText?: string | null;
  /** 为 true 时，仅显示 Brief tool 输出（隐藏其他所有内容） */
  isBriefOnly?: boolean;
  /** Fullscreen 模式下的 "─── N new ───" 分割线。渲染在第一个
   *  renderableMessage 之前，该消息从 firstUnseenUuid 派生（通过 deriveUUID 保留的 24 字符前缀匹配）。 */
  unseenDivider?: UnseenDivider;
  /** Fullscreen 模式下的 ScrollBox 句柄。存在时启用 React 级别的虚拟化。 */
  scrollRef?: RefObject<ScrollBoxHandle | null>;
  /** Fullscreen 模式：启用 sticky-prompt 追踪（通过 ScrollChromeContext 写入）。 */
  trackStickyPrompt?: boolean;
  /** Transcript 搜索：跳转到 index + setSearchQuery/nextMatch/prevMatch。 */
  jumpRef?: RefObject<JumpHandle | null>;
  /** Transcript 搜索：当匹配数量/位置变化时触发。 */
  onSearchMatchesChange?: (count: number, current: number) => void;
  /** 将现有 DOM 子树绘制到新的 Screen 上进行扫描。元素来自主树（所有真实的 providers）。消息相对位置。 */
  scanElement?: (el: import('../ink/dom.js').DOMElement) => import('../ink/render-to-screen.js').MatchPosition[];
  /** 基于位置的当前高亮。位置稳定（消息相对），rowOffset 追踪滚动。null 时清除。 */
  setPositions?: (state: {
    positions: import('../ink/render-to-screen.js').MatchPosition[];
    rowOffset: number;
    currentIdx: number;
  } | null) => void;
  /** 绕过 MAX_MESSAGES_WITHOUT_VIRTUALIZATION。用于一次性无头渲染
   *  （如 /export 通过 renderToString），此时内存问题不适用，且"已在 scrollback 中"的理由不成立。 */
  disableRenderCap?: boolean;
  /** Transcript 内的光标；展开后会覆盖所选消息的 verbose 设置。 */
  cursor?: MessageActionsState | null;
  setCursor?: (cursor: MessageActionsState | null) => void;
  /** 传递给 VirtualMessageList（heightCache 控制可见性）。 */
  cursorNavRef?: React.Ref<MessageActionsNav>;
  /** 仅渲染 collapsed.slice(start, end)。用于分块无头导出
   *  （exportRenderer.tsx 中的 streamRenderedMessages）：预处理在完整
   *  messages 数组上运行，以确保分组/lookups 正确，但只渲染这个切片
   *  而不是完整会话。logo 仅在 chunk 0 时渲染（start === 0）；后续 chunk 是中间流的延续。
   *  2026年3月测量：538 条消息的会话，20 个切片 → RSS 峰值降低 55%。 */
  renderRange?: readonly [start: number, end: number];
};
const MAX_MESSAGES_TO_SHOW_IN_TRANSCRIPT_MODE = 30;

// 非虚拟化渲染路径的安全上限（fullscreen 关闭或显式禁用）。Ink 为每条消息
// 挂载一个完整的 fiber 树（每条约 250 KB RSS）；yoga 布局高度无限制增长；
// 屏幕缓冲区大小要容纳每一行。约 2000 条消息时，这是约 3000 行的屏幕、
// 约 500 MB 的 fibers，以及每帧写入成本会将进程推入 GC 死亡螺旋
// （观察到的情况：59 GB RSS，14k mmap/munmap/秒）。从此切片中丢弃的内容
// 已经打印到终端 scrollback 中——用户仍然可以向上原生滚动。VirtualMessageList
// （默认 ant 路径）完全绕过此上限。无头一次性渲染（如 /export）传入
// disableRenderCap 来选择退出——它们没有 scrollback，且内存问题不适用于 renderToString。
//
// 切片边界追踪为 UUID anchor，而不是基于计数的索引。基于计数的切片（slice(-200)）
// 每次 append 都会从前面丢弃一条消息，移动 scrollback 内容并强制每个 turn 完全重置
// 终端（CC-941）。量化为 50 条消息的步长（CC-1154）有所帮助，但在压缩和 collapse
// 重组时仍然会移动，因为这些会改变 collapsed.length 而不添加消息。UUID anchor
// 仅在渲染计数真正超过 CAP+STEP 时才前进——不受分组/压缩的长度变化影响（CC-1174）。
//
// anchor 同时存储 uuid 和 index。某些 uuid 在渲染之间不稳定：collapseHookSummaries
// 从组中的第一个 summary 派生合并的 uuid，但 reorderMessagesInUI 会在 tool result
// 流式传入时重新排列 hook 相邻关系，改变哪个 summary 是第一个。当 uuid 消失时，
// 回退到存储的 index（夹紧）可以保持切片大致在原来的位置，而不是重置为 0——否则会从
// 约 200 条渲染消息跳到完整历史，使 scrollback 中进行中的 badge 快照成为孤儿。
const MAX_MESSAGES_WITHOUT_VIRTUALIZATION = 200;
const MESSAGE_CAP_STEP = 50;
export type SliceAnchor = {
  uuid: string;
  idx: number;
} | null;

/** 导出用于测试。当窗口需要前进时会变更 anchorRef。 */
export function computeSliceStart(collapsed: ReadonlyArray<{
  uuid: string;
}>, anchorRef: {
  current: SliceAnchor;
}, cap = MAX_MESSAGES_WITHOUT_VIRTUALIZATION, step = MESSAGE_CAP_STEP): number {
  const anchor = anchorRef.current;
  const anchorIdx = anchor ? collapsed.findIndex(m => m.uuid === anchor.uuid) : -1;
  // 找到 anchor → 使用它。丢失 anchor → 回退到存储的 index
  // （夹紧），这样 collapse 重新分组时的 uuid 变化不会重置为 0。
  let start = anchorIdx >= 0 ? anchorIdx : anchor ? Math.min(anchor.idx, Math.max(0, collapsed.length - cap)) : 0;
  if (collapsed.length - start > cap + step) {
    start = collapsed.length - cap;
  }
  // 从当前 start 处的消息刷新 anchor——回退后修复过时的 uuid，
  // 并在前进后捕获新的 anchor。
  const msgAtStart = collapsed[start];
  if (msgAtStart && (anchor?.uuid !== msgAtStart.uuid || anchor.idx !== start)) {
    anchorRef.current = {
      uuid: msgAtStart.uuid,
      idx: start
    };
  } else if (!msgAtStart && anchor) {
    anchorRef.current = null;
  }
  return start;
}
const MessagesImpl = ({
  messages,
  tools,
  commands,
  verbose,
  toolJSX,
  toolUseConfirmQueue,
  inProgressToolUseIDs,
  isMessageSelectorVisible,
  conversationId,
  screen,
  streamingToolUses,
  showAllInTranscript = false,
  agentDefinitions,
  onOpenRateLimitOptions,
  hideLogo = false,
  isLoading,
  hidePastThinking = false,
  streamingThinking,
  streamingText,
  isBriefOnly = false,
  unseenDivider,
  scrollRef,
  trackStickyPrompt,
  jumpRef,
  onSearchMatchesChange,
  scanElement,
  setPositions,
  disableRenderCap = false,
  cursor = null,
  setCursor,
  cursorNavRef,
  renderRange
}: Props): React.ReactNode => {
  const {
    columns
  } = useTerminalSize();
  const toggleShowAllShortcut = useShortcutDisplay('transcript:toggleShowAll', 'Transcript', 'Ctrl+E');
  const normalizedMessages = useMemo(() => normalizeMessages(messages).filter(isNotEmptyMessage), [messages]);

  // Check if streaming thinking should be visible (streaming or within 30s timeout)
  const isStreamingThinkingVisible = useMemo(() => {
    if (!streamingThinking) return false;
    if (streamingThinking.isStreaming) return true;
    if (streamingThinking.streamingEndedAt) {
      return Date.now() - streamingThinking.streamingEndedAt < 30000;
    }
    return false;
  }, [streamingThinking]);

  // 查找最后一个 thinking 块（消息 UUID + 内容 index），用于在 transcript 模式下隐藏过去的 thinking
  // 当 streaming thinking 可见时，使用一个不会匹配任何已完成 thinking 块的特殊 ID
  // 使用 adaptive thinking 时，仅考虑当前 turn 的 thinking 块，并在遇到最后一个 user 消息时停止搜索
  const lastThinkingBlockId = useMemo(() => {
    if (!hidePastThinking) return null;
    // 如果 streaming thinking 可见，通过使用不匹配的 ID 隐藏所有已完成的 thinking 块
    if (isStreamingThinkingVisible) return 'streaming';
    // 从后向前遍历，查找包含 thinking 块的最后一条消息
    for (let i = normalizedMessages.length - 1; i >= 0; i--) {
      const msg = normalizedMessages[i];
      if (msg?.type === 'assistant') {
        const content = msg.message.content;
        // 查找该消息中最后一个 thinking 块
        for (let j = content.length - 1; j >= 0; j--) {
          if (content[j]?.type === 'thinking') {
            return `${msg.uuid}:${j}`;
          }
        }
      } else if (msg?.type === 'user') {
        const hasToolResult = msg.message.content.some(block => block.type === 'tool_result');
        if (!hasToolResult) {
          // 已到达之前的 user turn，因此不显示之前的过时 thinking
          return 'no-thinking';
        }
      }
    }
    return null;
  }, [normalizedMessages, hidePastThinking, isStreamingThinkingVisible]);

  // 查找最新的用户 bash output 消息（来自 ! 命令）
  // 这样我们可以为最近的 bash 命令显示完整输出
  const latestBashOutputUUID = useMemo(() => {
    // 从后向前遍历，查找包含 bash output 的最后一条 user 消息
    for (let i_0 = normalizedMessages.length - 1; i_0 >= 0; i_0--) {
      const msg_0 = normalizedMessages[i_0];
      if (msg_0?.type === 'user') {
        const content_0 = msg_0.message.content;
        // 检查是否有任何文本内容是 bash output
        for (const block_0 of content_0) {
          if (block_0.type === 'text') {
            const text = block_0.text;
            if (text.startsWith('<bash-stdout') || text.startsWith('<bash-stderr')) {
              return msg_0.uuid;
            }
          }
        }
      }
    }
    return null;
  }, [normalizedMessages]);

  // streamingToolUses 在每个 input_json_delta 时更新，而 normalizedMessages
  // 保持稳定——预先计算 Set，使过滤为 O(k) 而不是每个 chunk O(n×k)。
  const normalizedToolUseIDs = useMemo(() => getToolUseIDs(normalizedMessages), [normalizedMessages]);
  const streamingToolUsesWithoutInProgress = useMemo(() => streamingToolUses.filter(stu => !inProgressToolUseIDs.has(stu.contentBlock.id) && !normalizedToolUseIDs.has(stu.contentBlock.id)), [streamingToolUses, inProgressToolUseIDs, normalizedToolUseIDs]);
  const syntheticStreamingToolUseMessages = useMemo(() => streamingToolUsesWithoutInProgress.flatMap(streamingToolUse => {
    const msg_1 = createAssistantMessage({
      content: [streamingToolUse.contentBlock]
    });
    // 使用从 content block ID 派生的确定性值覆盖 randomUUID，
    // 以防止每次 memo 重新计算时 React key 变化。
    // 与 normalizeMessages 中修复的同类 bug（commit 383326e613）：
    // 新的 randomUUID → 不稳定的 React key → 组件重新挂载 →
    // Ink 渲染损坏（来自过时 DOM 节点的重叠文本）。
    msg_1.uuid = deriveUUID(streamingToolUse.contentBlock.id as UUID, 0);
    return normalizeMessages([msg_1]);
  }), [streamingToolUsesWithoutInProgress]);
  const isTranscriptMode = screen === 'transcript';
  // 提升到 mount 时——该组件在每次滚动时都会重新渲染。
  const disableVirtualScroll = useMemo(() => isEnvTruthy(process.env.ZY_CODE_DISABLE_VIRTUAL_SCROLL), []);
  // 虚拟滚动替代了 transcript 上限：所有内容都可滚动，且
  // 内存受挂载项数量限制，而不是总量。scrollRef 仅在
  // isFullscreenEnvEnabled() 为 true 时传递（REPL.tsx 控制），
  // 因此 scrollRef 的存在就是信号。
  const virtualScrollRuntimeGate = scrollRef != null && !disableVirtualScroll;
  const shouldTruncate = isTranscriptMode && !showAllInTranscript && !virtualScrollRuntimeGate;

  // 非虚拟化上限切片中第一个渲染消息的 Anchor。
  // 仅单调前进——渲染期间的变更是幂等的（在 StrictMode 双重重渲染下安全）。
  // 有关为何替代基于计数的切片，请参阅上面的 MAX_MESSAGES_WITHOUT_VIRTUALIZATION 注释。
  const sliceAnchorRef = useRef<SliceAnchor>(null);

  // 昂贵的消息转换——过滤、重新排序、分组、折叠、lookups。
  // 在 27k 条消息上都是 O(n)。与 renderRange 切片分开，这样滚动
  // （仅改变 renderRange）不会重新运行这些。之前这个 useMemo 包含
  // renderRange → 每次滚动都在 27k 条消息上重建 6 个 Map +
  // 4 次过滤/map 传递 = 每次滚动约 50ms 分配 → GC 压力 →
  // 在 1GB 堆上出现 100-173ms 的 stop-the-world 暂停。
  const {
    collapsed: collapsed_0,
    lookups: lookups_0,
    hasTruncatedMessages: hasTruncatedMessages_0,
    hiddenMessageCount: hiddenMessageCount_0
  } = useMemo(() => {
    // 在 fullscreen 模式下，alt buffer 没有原生 scrollback，所以
    // compact-boundary 过滤器只是隐藏了 ScrollBox 可以滚动到的历史。
    // 主屏幕模式保留过滤器——pre-compact 行存在于原生 scrollback 中的
    // 视口上方，重新渲染它们会触发完全重置。
    // includeSnipped：UI 渲染保留 snipped 消息用于 scrollback
    // （此 PR 的核心目标——UI 中保留完整历史，仅对模型过滤）。
    // 同时避免 UUID 不匹配：normalizeMessages 派生新的 UUID，所以
    // projectSnippedView 对原始 removedUuids 的检查会失败。
    const compactAwareMessages = verbose || isFullscreenEnvEnabled() ? normalizedMessages : getMessagesAfterCompactBoundary(normalizedMessages, {
      includeSnipped: true
    });
    const messagesToShowNotTruncated = reorderMessagesInUI(compactAwareMessages.filter((msg_2): msg_2 is Exclude<NormalizedMessage, ProgressMessageType> => msg_2.type !== 'progress')
    // CC-724：丢弃 AttachmentMessage 渲染为 null 的 attachment 消息
    // （hook_success、hook_additional_context、hook_cancelled 等）
    // 在计数/切片之前执行，这样它们不会膨胀 ctrl-o 中的"N messages"
    // 计数，也不会占用 200 条消息渲染上限中的槽位。
    .filter(msg_3 => !isNullRenderingAttachment(msg_3)).filter(_ => shouldShowUserMessage(_, isTranscriptMode)), syntheticStreamingToolUseMessages);
    // 三层过滤。Transcript 模式（ctrl+o 屏幕）真正不过滤。
    // Brief-only：仅 SendUserMessage + 用户输入。默认：丢弃调用了
    // SendUserMessage 的 turn 中的冗余 assistant 文本（模型的文本是
    // 与 SendUserMessage 内容重复的工作笔记）。
    const briefToolNames = [BRIEF_TOOL_NAME, SEND_USER_FILE_TOOL_NAME].filter((n): n is string => n !== null);
    // dropTextInBriefTurns 应仅在 SendUserMessage turn 时触发——
    // SendUserFile 传递文件而不替换文本，因此为纯文件 turn 丢弃
    // assistant 文本会让用户失去上下文。
    const dropTextToolNames = [BRIEF_TOOL_NAME].filter((n_0): n_0 is string => n_0 !== null);
    const briefFiltered = briefToolNames.length > 0 && !isTranscriptMode ? isBriefOnly ? filterForBriefTool(messagesToShowNotTruncated, briefToolNames) : dropTextToolNames.length > 0 ? dropTextInBriefTurns(messagesToShowNotTruncated, dropTextToolNames) : messagesToShowNotTruncated : messagesToShowNotTruncated;
    const messagesToShow = shouldTruncate ? briefFiltered.slice(-MAX_MESSAGES_TO_SHOW_IN_TRANSCRIPT_MODE) : briefFiltered;
    const hasTruncatedMessages = shouldTruncate && briefFiltered.length > MAX_MESSAGES_TO_SHOW_IN_TRANSCRIPT_MODE;
    const {
      messages: groupedMessages
    } = applyGrouping(messagesToShow, tools, verbose);
    const collapsed = collapseBackgroundBashNotifications(collapseHookSummaries(collapseTeammateShutdowns(collapseReadSearchGroups(groupedMessages, tools))), verbose);
    const lookups = buildMessageLookups(normalizedMessages, messagesToShow);
    const hiddenMessageCount = messagesToShowNotTruncated.length - MAX_MESSAGES_TO_SHOW_IN_TRANSCRIPT_MODE;
    return {
      collapsed,
      lookups,
      hasTruncatedMessages,
      hiddenMessageCount
    };
  }, [verbose, normalizedMessages, isTranscriptMode, syntheticStreamingToolUseMessages, shouldTruncate, tools, isBriefOnly]);

  // 廉价切片——仅在滚动范围或切片配置变化时运行。
  const renderableMessages = useMemo(() => {
    // 非虚拟化渲染路径的安全上限。在此处应用（而不是在
    // JSX 处），以便 renderMessageRow 的基于 index 的查找和
    // dividerBeforeIndex 在同一数组上计算。VirtualMessageList
    // 永远不会看到这个切片——virtualScrollRuntimeGate 在组件
    // 生命周期内是常量（scrollRef 要么始终传递，要么从不）。
    // renderRange 优先：分块导出路径对分组后的数组进行切片，
    // 这样每个 chunk 都能获得正确的 tool-call 分组。
    const capApplies = !virtualScrollRuntimeGate && !disableRenderCap;
    const sliceStart = capApplies ? computeSliceStart(collapsed_0, sliceAnchorRef) : 0;
    return renderRange ? collapsed_0.slice(renderRange[0], renderRange[1]) : sliceStart > 0 ? collapsed_0.slice(sliceStart) : collapsed_0;
  }, [collapsed_0, renderRange, virtualScrollRuntimeGate, disableRenderCap]);
  const streamingToolUseIDs = useMemo(() => new Set(streamingToolUses.map(__0 => __0.contentBlock.id)), [streamingToolUses]);

  // 分割线插入点：第一个 renderableMessage，其 uuid 与 firstUnseenUuid
  // 共享 24 字符前缀（deriveUUID 保留源消息 uuid 的前 24 个字符，因此这会匹配其中的任何块）。
  const dividerBeforeIndex = useMemo(() => {
    if (!unseenDivider) return -1;
    const prefix = unseenDivider.firstUnseenUuid.slice(0, 24);
    return renderableMessages.findIndex(m => m.uuid.slice(0, 24) === prefix);
  }, [unseenDivider, renderableMessages]);
  const selectedIdx = useMemo(() => {
    if (!cursor) return -1;
    return renderableMessages.findIndex(m_0 => m_0.uuid === cursor.uuid);
  }, [cursor, renderableMessages]);

  // Fullscreen：点击消息可切换该消息的 verbose 渲染。使用
  // tool_use_id 作为 key（如果可用），这样 tool_use 和它的 tool_result
  // （分开的行）可以同时展开；对于 groups/thinking 回退到 uuid。
  // 过时的 key 是无害的——它们永远不会匹配 renderableMessages 中的任何内容。
  const [expandedKeys, setExpandedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const onItemClick = useCallback((msg_4: RenderableMessage) => {
    const k = expandKey(msg_4);
    setExpandedKeys(prev => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);else next.add(k);
      return next;
    });
  }, []);
  const isItemExpanded = useCallback((msg_5: RenderableMessage) => expandedKeys.size > 0 && expandedKeys.has(expandKey(msg_5)), [expandedKeys]);
  // 仅在 verbose 切换能揭示更多内容的消息上启用 hover/click：
  // collapsed read/search 组，或通过 isResultTruncated 自报告截断的 tool result。
  // Callback 在消息更新期间必须保持稳定：如果其身份（或返回值）在
  // streaming 期间翻转，onMouseEnter 会在鼠标已经在内部之后才附加 →
  // hover 永远不会触发。tools 在会话期间稳定；lookups 通过 ref 读取，
  // 因此 callback 不会在每条新消息时都变化。
  const lookupsRef = useRef(lookups_0);
  lookupsRef.current = lookups_0;
  const isItemClickable = useCallback((msg_6: RenderableMessage): boolean => {
    if (msg_6.type === 'collapsed_read_search') return true;
    if (msg_6.type === 'assistant') {
      const b = msg_6.message.content[0] as unknown as AdvisorBlock | undefined;
      return b != null && isAdvisorBlock(b) && b.type === 'advisor_tool_result' && b.content.type === 'advisor_result';
    }
    if (msg_6.type !== 'user') return false;
    const b_0 = msg_6.message.content[0];
    if (b_0?.type !== 'tool_result' || b_0.is_error || !msg_6.toolUseResult) return false;
    const name = lookupsRef.current.toolUseByToolUseID.get(b_0.tool_use_id)?.name;
    const tool = name ? findToolByName(tools, name) : undefined;
    return tool?.isResultTruncated?.(msg_6.toolUseResult as never) ?? false;
  }, [tools]);
  const canAnimate = (!toolJSX || !!toolJSX.shouldContinueAnimation) && !toolUseConfirmQueue.length && !isMessageSelectorVisible;
  const hasToolsInProgress = inProgressToolUseIDs.size > 0;

  // 向终端报告进度（用于支持 OSC 9;4 的终端）
  const {
    progress
  } = useTerminalNotification();
  const prevProgressState = useRef<string | null>(null);
  const progressEnabled = getGlobalConfig().terminalProgressBarEnabled && !getIsRemoteMode() && !(proactiveModule?.isProactiveActive() ?? false);
  useEffect(() => {
    const state = progressEnabled ? hasToolsInProgress ? 'indeterminate' : 'completed' : null;
    if (prevProgressState.current === state) return;
    prevProgressState.current = state;
    progress(state);
  }, [progress, progressEnabled, hasToolsInProgress]);
  useEffect(() => {
    return () => progress(null);
  }, [progress]);
  const messageKey = useCallback((msg_7: RenderableMessage) => `${msg_7.uuid}-${conversationId}`, [conversationId]);
  const renderMessageRow = (msg_8: RenderableMessage, index: number) => {
    const prevType = index > 0 ? renderableMessages[index - 1]?.type : undefined;
    const isUserContinuation = msg_8.type === 'user' && prevType === 'user';
    // hasContentAfter 仅用于 collapsed_read_search 组；
    // 跳过对其他所有内容的扫描。streamingText 在此 map 之后作为
    // 兄弟节点渲染，因此它永远不会在 renderableMessages 中——除非
    // 显式放入，这样组一旦开始 stream 文本就会切换为过去式，
    // 而不是等待块完成。
    const hasContentAfter = msg_8.type === 'collapsed_read_search' && (!!streamingText || hasContentAfterIndex(renderableMessages, index, tools, streamingToolUseIDs));
    const k_0 = messageKey(msg_8);
    const row = <MessageRow key={k_0} message={msg_8} isUserContinuation={isUserContinuation} hasContentAfter={hasContentAfter} tools={tools} commands={commands} verbose={verbose || isItemExpanded(msg_8) || cursor?.expanded === true && index === selectedIdx} inProgressToolUseIDs={inProgressToolUseIDs} streamingToolUseIDs={streamingToolUseIDs} screen={screen} canAnimate={canAnimate} onOpenRateLimitOptions={onOpenRateLimitOptions} lastThinkingBlockId={lastThinkingBlockId} latestBashOutputUUID={latestBashOutputUUID} columns={columns} isLoading={isLoading} lookups={lookups_0} />;

    // 每行的 Provider——选择变更时只有 2 行重新渲染。
    // 在 divider 分支之前包装，这样两个返回路径都能获取到它。
    const wrapped = <MessageActionsSelectedContext.Provider key={k_0} value={index === selectedIdx}>
        {row}
      </MessageActionsSelectedContext.Provider>;
    if (unseenDivider && index === dividerBeforeIndex) {
      return [<Box key="unseen-divider" marginTop={1}>
          <Divider title={`${unseenDivider.count} new ${plural(unseenDivider.count, 'message')}`} width={columns} color="inactive" />
        </Box>, wrapped];
    }
    return wrapped;
  };

  // 搜索索引：对于 tool_result 消息，查找 Tool 并使用
  // 其 extractSearchText——由 tool 拥有，精确，与
  // renderToolResultMessage 显示的内容匹配。对于尚未实现它的 tool，
  // 以及所有非 tool-result 消息类型，回退到 renderableSearchText
  // （duck-type toolUseResult）。drift-catcher 测试
  // （toolSearchText.test.tsx）渲染并比较以保持同步。
  //
  // 曾尝试并排除了第二种 React root reconcile 方法
  // （测量为 3.1ms/条消息，还在增长——flushSyncWork 处理所有 root；
  // 组件 hook 变更共享状态 → 主 root 累积更新）。
  const searchTextCache = useRef(new WeakMap<RenderableMessage, string>());
  const extractSearchText = useCallback((msg_9: RenderableMessage): string => {
    const cached = searchTextCache.current.get(msg_9);
    if (cached !== undefined) return cached;
    let text_0 = renderableSearchText(msg_9);
    // 如果这是 tool_result 消息且 tool 实现了
    // extractSearchText，优先使用它——比 renderableSearchText 的
    // 字段名启发式更精确（由 tool 拥有）。
    if (msg_9.type === 'user' && msg_9.toolUseResult && Array.isArray(msg_9.message.content)) {
      const tr = msg_9.message.content.find(b_1 => b_1.type === 'tool_result');
      if (tr && 'tool_use_id' in tr) {
        const tu = lookups_0.toolUseByToolUseID.get(tr.tool_use_id);
        const tool_0 = tu && findToolByName(tools, tu.name);
        const extracted = tool_0?.extractSearchText?.(msg_9.toolUseResult as never);
        // undefined = tool 未实现 → 保留启发式。空字符串 = tool
        // 说"没有可索引的内容" → 遵从它。
        if (extracted !== undefined) text_0 = extracted;
      }
    }
    // 缓存小写形式：setSearchQuery 的热循环在每次击键时进行 indexOf。
    // 在此处小写（一次，预热时）对比在热循环中（每次击键）用
    // 大致相同的稳态内存换取零每次击键分配。缓存会随消息在
    // 退出 transcript 时 GC。Tool 方法返回原始值；
    // renderableSearchText 已经小写（冗余但廉价）。
    const lowered = text_0.toLowerCase();
    searchTextCache.current.set(msg_9, lowered);
    return lowered;
  }, [tools, lookups_0]);
  return <>
      {/* Logo */}
      {!hideLogo && !(renderRange && renderRange[0] > 0) && <LogoHeader agentDefinitions={agentDefinitions} />}

      {/* 截断指示器 */}
      {hasTruncatedMessages_0 && <Divider title={`${toggleShowAllShortcut} to show ${chalk.bold(hiddenMessageCount_0)} previous messages`} width={columns} />}

      {/* 显示全部指示器 */}
      {isTranscriptMode && showAllInTranscript && hiddenMessageCount_0 > 0 &&
    // disableRenderCap（如 [ dump-to-scrollback）意味着我们作为一次性
    // 逃生通道不受上限限制，而不是切换——ctrl+e 无效，且实际上没有
    // 任何"隐藏"内容可恢复。
    !disableRenderCap && <Divider title={`${toggleShowAllShortcut} to hide ${chalk.bold(hiddenMessageCount_0)} previous messages`} width={columns} />}

      {/* 消息——渲染为经过 memo 的 MessageRow 组件。
          flatMap 将 unseen-divider 作为独立的 keyed 兄弟插入，这样
          (a) 非 fullscreen 渲染无需为每条消息支付 Fragment 包装，且
          (b) fullscreen 中的 divider 切换通过 key 保留所有 MessageRows。
          预先计算派生值而不是将 renderableMessages 传递给每行——
          React Compiler 将 props 固定在 fiber 的 memoCache 中，所以
          传递数组会累积每个历史版本（7 turn 会话约 1-2MB）。 */}
      {virtualScrollRuntimeGate ? <InVirtualListContext.Provider value={true}>
          <VirtualMessageList messages={renderableMessages} scrollRef={scrollRef} columns={columns} itemKey={messageKey} renderItem={renderMessageRow} onItemClick={onItemClick} isItemClickable={isItemClickable} isItemExpanded={isItemExpanded} trackStickyPrompt={trackStickyPrompt} selectedIndex={selectedIdx >= 0 ? selectedIdx : undefined} cursorNavRef={cursorNavRef} setCursor={setCursor} jumpRef={jumpRef} onSearchMatchesChange={onSearchMatchesChange} scanElement={scanElement} setPositions={setPositions} extractSearchText={extractSearchText} />
        </InVirtualListContext.Provider> : renderableMessages.flatMap(renderMessageRow)}

      {streamingText && !isBriefOnly && <Box alignItems="flex-start" flexDirection="row" marginTop={1} width="100%">
          <Box flexDirection="row">
            <Box minWidth={2}>
              <Text color="text">{BLACK_CIRCLE}</Text>
            </Box>
            <Box flexDirection="column">
              <StreamingMarkdown>{streamingText}</StreamingMarkdown>
            </Box>
          </Box>
        </Box>}

      {isStreamingThinkingVisible && streamingThinking && !isBriefOnly && <Box marginTop={1}>
          <AssistantThinkingMessage param={{
        type: 'thinking',
        thinking: streamingThinking.thinking
      }} addMargin={false} isTranscriptMode={true} verbose={verbose} hideInTranscript={false} />
        </Box>}
    </>;
};

/** click-to-expand 的 key：使用 tool_use_id（如果可用，这样 tool_use + 其
 *  tool_result 可以同时展开），否则对 groups/thinking 使用 uuid。 */
function expandKey(msg: RenderableMessage): string {
  return (msg.type === 'assistant' || msg.type === 'user' ? getToolUseID(msg) : null) ?? msg.uuid;
}

// 自定义比较器，防止 streaming 期间不必要的重新渲染。
// 默认 React.memo 进行浅比较，在以下情况会失败：
// 1. onOpenRateLimitOptions callback 被重新创建（不影响渲染输出）
// 2. streamingToolUses 数组在每个 delta 时重新创建，但只有 contentBlock 对渲染重要
// 3. streamingThinking 在每个 delta 时变化——我们确实想为此重新渲染
function setsEqual<T>(a: Set<T>, b: Set<T>): boolean {
  if (a.size !== b.size) return false;
  for (const item of a) {
    if (!b.has(item)) return false;
  }
  return true;
}
export const Messages = React.memo(MessagesImpl, (prev, next) => {
  const keys = Object.keys(prev) as (keyof typeof prev)[];
  for (const key of keys) {
    if (key === 'onOpenRateLimitOptions' || key === 'scrollRef' || key === 'trackStickyPrompt' || key === 'setCursor' || key === 'cursorNavRef' || key === 'jumpRef' || key === 'onSearchMatchesChange' || key === 'scanElement' || key === 'setPositions') continue;
    if (prev[key] !== next[key]) {
      if (key === 'streamingToolUses') {
        const p = prev.streamingToolUses;
        const n = next.streamingToolUses;
        if (p.length === n.length && p.every((item, i) => item.contentBlock === n[i]?.contentBlock)) {
          continue;
        }
      }
      if (key === 'inProgressToolUseIDs') {
        if (setsEqual(prev.inProgressToolUseIDs, next.inProgressToolUseIDs)) {
          continue;
        }
      }
      if (key === 'unseenDivider') {
        const p = prev.unseenDivider;
        const n = next.unseenDivider;
        if (p?.firstUnseenUuid === n?.firstUnseenUuid && p?.count === n?.count) {
          continue;
        }
      }
      if (key === 'tools') {
        const p = prev.tools;
        const n = next.tools;
        if (p.length === n.length && p.every((tool, i) => tool.name === n[i]?.name)) {
          continue;
        }
      }
      // streamingThinking 频繁变化——在其变化时始终重新渲染
      // （无需特殊处理，默认行为是正确的）
      return false;
    }
  }
  return true;
});
export function shouldRenderStatically(message: RenderableMessage, streamingToolUseIDs: Set<string>, inProgressToolUseIDs: Set<string>, siblingToolUseIDs: ReadonlySet<string>, screen: Screen, lookups: ReturnType<typeof buildMessageLookups>): boolean {
  if (screen === 'transcript') {
    return true;
  }
  switch (message.type) {
    case 'attachment':
    case 'user':
    case 'assistant':
      {
        if (message.type === 'assistant') {
          const block = message.message.content[0];
          if (block?.type === 'server_tool_use') {
            return lookups.resolvedToolUseIDs.has(block.id);
          }
        }
        const toolUseID = getToolUseID(message);
        if (!toolUseID) {
          return true;
        }
        if (streamingToolUseIDs.has(toolUseID)) {
          return false;
        }
        if (inProgressToolUseIDs.has(toolUseID)) {
          return false;
        }

        // 检查此 tool use 是否有未解决的 PostToolUse hook
        // 如果有，保持消息为 transient，以便 HookProgressMessage 可以更新
        if (hasUnresolvedHooksFromLookup(toolUseID, 'PostToolUse', lookups)) {
          return false;
        }
        return every(siblingToolUseIDs, lookups.resolvedToolUseIDs);
      }
    case 'system':
      {
        // api error 始终动态渲染，因为我们在看到其他非 error 消息时会立即隐藏它们
        return message.subtype !== 'api_error';
      }
    case 'grouped_tool_use':
      {
        const allResolved = message.messages.every(msg => {
          const content = msg.message.content[0];
          return content?.type === 'tool_use' && lookups.resolvedToolUseIDs.has(content.id);
        });
        return allResolved;
      }
    case 'collapsed_read_search':
      {
        // 在 prompt 模式下，永远不标记为 static，以防止 API turn 之间闪烁
        // （在 transcript 模式下，我们已经在函数顶部返回了 true）
        return false;
      }
  }
}
