import { feature } from 'bun:bundle';
import * as React from 'react';
import { Box, Text } from '../ink.js';
import type { ContextData } from '../utils/analyzeContext.js';
import { generateContextSuggestions } from '../utils/contextSuggestions.js';
import { getDisplayPath } from '../utils/file.js';
import { formatTokens } from '../utils/format.js';
import { getSourceDisplayName, type SettingSource } from '../utils/settings/constants.js';
import { plural } from '../utils/stringUtils.js';
import { ContextSuggestions } from './ContextSuggestions.js';
const RESERVED_CATEGORY_NAME = 'Autocompact buffer';

/**
 * One-liner for the legend header showing what context-collapse has done.
 * Returns null when nothing's summarized/staged so we don't add visual
 * noise in the common case. This is the one place a user can see that
 * their context was rewritten — the <collapsed> placeholders are isMeta
 * and don't appear in the conversation view.
 */
function CollapseStatus() {
  if (feature("CONTEXT_COLLAPSE")) {
    const {
      getStats,
      isContextCollapseEnabled
    } = require("../services/contextCollapse/index.js") as typeof import('../services/contextCollapse/index.js');
    if (!isContextCollapseEnabled()) {
      return null;
    }
    const s = getStats();
    const {
      health: h
    } = s;
    const parts = [];
    if (s.collapsedSpans > 0) {
      parts.push(`${s.collapsedSpans} ${plural(s.collapsedSpans, "span")} summarized (${s.collapsedMessages} msgs)`);
    }
    if (s.stagedSpans > 0) {
      parts.push(`${s.stagedSpans} staged`);
    }
    const summary = parts.length > 0 ? parts.join(", ") : h.totalSpawns > 0 ? `${h.totalSpawns} ${plural(h.totalSpawns, "spawn")}, nothing staged yet` : "waiting for first trigger";
    let line2 = null;
    if (h.totalErrors > 0) {
      line2 = <Text color="warning">Collapse errors: {h.totalErrors}/{h.totalSpawns} spawns failed{h.lastError ? ` (last: ${h.lastError.slice(0, 60)})` : ""}</Text>;
    } else {
      if (h.emptySpawnWarningEmitted) {
        line2 = <Text color="warning">Collapse idle: {h.totalEmptySpawns} consecutive empty runs</Text>;
      }
    }
    return <><Text dimColor={true}>Context strategy: collapse ({summary})</Text>{line2}</>;
  }
  return null;
}

// Order for displaying source groups: Project > User > Managed > Plugin > Built-in
const SOURCE_DISPLAY_ORDER = ['Project', 'User', 'Managed', 'Plugin', 'Built-in'];

/** Group items by source type for display, sorted by tokens descending within each group */
function groupBySource<T extends {
  source: SettingSource | 'plugin' | 'built-in';
  tokens: number;
}>(items: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = getSourceDisplayName(item.source);
    const existing = groups.get(key) || [];
    existing.push(item);
    groups.set(key, existing);
  }
  // Sort each group by tokens descending
  for (const [key, group] of groups.entries()) {
    groups.set(key, group.sort((a, b) => b.tokens - a.tokens));
  }
  // Return groups in consistent order
  const orderedGroups = new Map<string, T[]>();
  for (const source of SOURCE_DISPLAY_ORDER) {
    const group = groups.get(source);
    if (group) {
      orderedGroups.set(source, group);
    }
  }
  return orderedGroups;
}
interface Props {
  data: ContextData;
}
export function ContextVisualization({
  data
}: Props) {
  const {
    categories,
    totalTokens,
    rawMaxTokens,
    percentage,
    gridRows,
    model,
    memoryFiles,
    mcpTools,
    deferredBuiltinTools: t1,
    systemTools,
    systemPromptSections,
    agents,
    skills,
    messageBreakdown
  } = data;
  const deferredBuiltinTools = t1 === undefined ? [] : t1;
  const visibleCategories = categories.filter(cat => cat.tokens > 0 && cat.name !== "Free space" && cat.name !== RESERVED_CATEGORY_NAME && !cat.isDeferred);
  const hasDeferredMcpTools = categories.some(cat_0 => cat_0.isDeferred && cat_0.name.includes("MCP"));
  const hasDeferredBuiltinTools = deferredBuiltinTools.length > 0;
  const autocompactCategory = categories.find(cat_1 => cat_1.name === RESERVED_CATEGORY_NAME);
  const gridRowElements = gridRows.map((row, rowIndex) => <Box key={rowIndex} flexDirection="row" marginLeft={-1}>{row.map((square, colIndex) => {
      if (square.categoryName === "Free space") {
        return <Text key={colIndex} dimColor={true}>{"\u26F6 "}</Text>;
      }
      if (square.categoryName === RESERVED_CATEGORY_NAME) {
        return <Text key={colIndex} color={square.color}>{"\u26DD "}</Text>;
      }
      return <Text key={colIndex} color={square.color}>{square.squareFullness >= 0.7 ? "\u26C1 " : "\u26C0 "}</Text>;
    })}</Box>);
  const gridBox = <Box flexDirection="column" flexShrink={0}>{gridRowElements}</Box>;
  const totalTokensFormatted = formatTokens(totalTokens);
  const maxTokensFormatted = formatTokens(rawMaxTokens);
  const modelInfoText = <Text dimColor={true}>{model} · {totalTokensFormatted}/{maxTokensFormatted}{" "}tokens ({percentage}%)</Text>;
  const collapseStatus = <CollapseStatus />;
  const spacer = <Text> </Text>;
  const t20 = visibleCategories.map((cat_2, index) => {
    const tokenDisplay = formatTokens(cat_2.tokens);
    const percentDisplay = cat_2.isDeferred ? "N/A" : `${(cat_2.tokens / rawMaxTokens * 100).toFixed(1)}%`;
    const isReserved = cat_2.name === RESERVED_CATEGORY_NAME;
    const displayName = cat_2.name;
    const symbol = cat_2.isDeferred ? " " : isReserved ? "\u26DD" : "\u26C1";
    return <Box key={index}><Text color={cat_2.color}>{symbol}</Text><Text> {displayName}: </Text><Text dimColor={true}>{tokenDisplay} tokens ({percentDisplay})</Text></Box>;
  });
  const t21 = (categories.find(c_1 => c_1.name === "Free space")?.tokens ?? 0) > 0 && <Box><Text dimColor={true}>⛶</Text><Text> Free space: </Text><Text dimColor={true}>{formatTokens(categories.find(c => c.name === "Free space")?.tokens || 0)}{" "}({((categories.find(c_0 => c_0.name === "Free space")?.tokens || 0) / rawMaxTokens * 100).toFixed(1)}%)</Text></Box>;
  const T1 = Box;
  const T0 = Box;
  const t12 = memoryFiles.length > 0 && <Box flexDirection="column" marginTop={1}><Box><Text bold={true}>Memory files</Text><Text dimColor={true}> · /memory</Text></Box>{memoryFiles.map((file, i_7) => <Box key={i_7}><Text>└ {getDisplayPath(file.path)}: </Text><Text dimColor={true}>{formatTokens(file.tokens)} tokens</Text></Box>)}</Box>;
  const t15 = <T0 flexDirection={"column"} marginLeft={-1}>{mcpTools.length > 0 && <Box flexDirection="column" marginTop={1}><Box><Text bold={true}>MCP tools</Text><Text dimColor={true}>{" "}· /mcp{hasDeferredMcpTools ? " (loaded on-demand)" : ""}</Text></Box>{mcpTools.some(t_0 => t_0.isLoaded) && <Box flexDirection="column" marginTop={1}><Text dimColor={true}>Loaded</Text>{mcpTools.filter(t => t.isLoaded).map((tool, i) => <Box key={i}><Text>└ {tool.name}: </Text><Text dimColor={true}>{formatTokens(tool.tokens)} tokens</Text></Box>)}</Box>}{hasDeferredMcpTools && mcpTools.some(t_2 => !t_2.isLoaded) && <Box flexDirection="column" marginTop={1}><Text dimColor={true}>Available</Text>{mcpTools.filter(t_1 => !t_1.isLoaded).map((tool_0, i_0) => <Box key={i_0}><Text dimColor={true}>└ {tool_0.name}</Text></Box>)}</Box>}{!hasDeferredMcpTools && mcpTools.map((tool_1, i_1) => <Box key={i_1}><Text>└ {tool_1.name}: </Text><Text dimColor={true}>{formatTokens(tool_1.tokens)} tokens</Text></Box>)}</Box>}{(systemTools && systemTools.length > 0 || hasDeferredBuiltinTools) && false && <Box flexDirection="column" marginTop={1}><Box><Text bold={true}>[ANT-ONLY] System tools</Text>{hasDeferredBuiltinTools && <Text dimColor={true}> (some loaded on-demand)</Text>}</Box><Box flexDirection="column" marginTop={1}><Text dimColor={true}>Loaded</Text>{systemTools?.map((tool_2, i_2) => <Box key={`sys-${i_2}`}><Text>└ {tool_2.name}: </Text><Text dimColor={true}>{formatTokens(tool_2.tokens)} tokens</Text></Box>)}{deferredBuiltinTools.filter(t_3 => t_3.isLoaded).map((tool_3, i_3) => <Box key={`def-${i_3}`}><Text>└ {tool_3.name}: </Text><Text dimColor={true}>{formatTokens(tool_3.tokens)} tokens</Text></Box>)}</Box>{hasDeferredBuiltinTools && deferredBuiltinTools.some(t_5 => !t_5.isLoaded) && <Box flexDirection="column" marginTop={1}><Text dimColor={true}>Available</Text>{deferredBuiltinTools.filter(t_4 => !t_4.isLoaded).map((tool_4, i_4) => <Box key={i_4}><Text dimColor={true}>└ {tool_4.name}</Text></Box>)}</Box>}</Box>}{systemPromptSections && systemPromptSections.length > 0 && false && <Box flexDirection="column" marginTop={1}><Text bold={true}>[ANT-ONLY] System prompt sections</Text>{systemPromptSections.map((section, i_5) => <Box key={i_5}><Text>└ {section.name}: </Text><Text dimColor={true}>{formatTokens(section.tokens)} tokens</Text></Box>)}</Box>}{agents.length > 0 && <Box flexDirection="column" marginTop={1}><Box><Text bold={true}>Custom agents</Text><Text dimColor={true}> · /agents</Text></Box>{Array.from(groupBySource(agents).entries()).map(t0 => {
        const [sourceDisplay, sourceAgents] = t0;
        return <Box key={sourceDisplay} flexDirection="column" marginTop={1}><Text dimColor={true}>{sourceDisplay}</Text>{sourceAgents.map((agent, i_6) => <Box key={i_6}><Text>└ {agent.agentType}: </Text><Text dimColor={true}>{formatTokens(agent.tokens)} tokens</Text></Box>)}</Box>;
      })}</Box>}{t12}{skills && skills.tokens > 0 && <Box flexDirection="column" marginTop={1}><Box><Text bold={true}>Skills</Text><Text dimColor={true}> · /skills</Text></Box>{Array.from(groupBySource(skills.skillFrontmatter).entries()).map(t0 => {
        const [sourceDisplay_0, sourceSkills] = t0;
        return <Box key={sourceDisplay_0} flexDirection="column" marginTop={1}><Text dimColor={true}>{sourceDisplay_0}</Text>{sourceSkills.map((skill, i_8) => <Box key={i_8}><Text>└ {skill.name}: </Text><Text dimColor={true}>{formatTokens(skill.tokens)} tokens</Text></Box>)}</Box>;
      })}</Box>}{messageBreakdown && false && <Box flexDirection="column" marginTop={1}><Text bold={true}>[ANT-ONLY] Message breakdown</Text><Box flexDirection="column" marginLeft={1}><Box><Text>Tool calls: </Text><Text dimColor={true}>{formatTokens(messageBreakdown.toolCallTokens)} tokens</Text></Box><Box><Text>Tool results: </Text><Text dimColor={true}>{formatTokens(messageBreakdown.toolResultTokens)} tokens</Text></Box><Box><Text>Attachments: </Text><Text dimColor={true}>{formatTokens(messageBreakdown.attachmentTokens)} tokens</Text></Box><Box><Text>Assistant messages (non-tool): </Text><Text dimColor={true}>{formatTokens(messageBreakdown.assistantMessageTokens)} tokens</Text></Box><Box><Text>User messages (non-tool-result): </Text><Text dimColor={true}>{formatTokens(messageBreakdown.userMessageTokens)} tokens</Text></Box></Box>{messageBreakdown.toolCallsByType.length > 0 && <Box flexDirection="column" marginTop={1}><Text bold={true}>[ANT-ONLY] Top tools</Text>{messageBreakdown.toolCallsByType.slice(0, 5).map((tool_5, i_9) => <Box key={i_9} marginLeft={1}><Text>└ {tool_5.name}: </Text><Text dimColor={true}>calls {formatTokens(tool_5.callTokens)}, results{" "}{formatTokens(tool_5.resultTokens)}</Text></Box>)}</Box>}{messageBreakdown.attachmentsByType.length > 0 && <Box flexDirection="column" marginTop={1}><Text bold={true}>[ANT-ONLY] Top attachments</Text>{messageBreakdown.attachmentsByType.slice(0, 5).map((attachment, i_10) => <Box key={i_10} marginLeft={1}><Text>└ {attachment.name}: </Text><Text dimColor={true}>{formatTokens(attachment.tokens)} tokens</Text></Box>)}</Box>}</Box>}</T0>;
  const contextSuggestions = generateContextSuggestions(data);
  const contextSuggestionsElement = <ContextSuggestions suggestions={contextSuggestions} />;
  return <T1 flexDirection={"column"} paddingLeft={1}>{<Text bold={true}>Context Usage</Text>}{<Box flexDirection="row" gap={2}>{gridBox}{<Box flexDirection="column" gap={0} flexShrink={0}>{modelInfoText}{collapseStatus}{spacer}{<Text dimColor={true} italic={true}>Estimated usage by category</Text>}{t20}{t21}{autocompactCategory && autocompactCategory.tokens > 0 && <Box><Text color={autocompactCategory.color}>⛝</Text><Text dimColor={true}> {autocompactCategory.name}: </Text><Text dimColor={true}>{formatTokens(autocompactCategory.tokens)} tokens ({(autocompactCategory.tokens / rawMaxTokens * 100).toFixed(1)}%)</Text></Box>}</Box>}</Box>}{t15}{contextSuggestionsElement}</T1>;
}
