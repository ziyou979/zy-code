import * as React from 'react';
import { Box, Text } from '../ink.js';
import { formatNumber } from '../utils/format.js';
import type { Theme } from '../utils/theme.js';
type Props = {
  agentType: string;
  description?: string;
  name?: string;
  descriptionColor?: keyof Theme;
  taskDescription?: string;
  toolUseCount: number;
  tokens: number | null;
  color?: keyof Theme;
  isLast: boolean;
  isResolved: boolean;
  isError: boolean;
  isAsync?: boolean;
  shouldAnimate: boolean;
  lastToolInfo?: string | null;
  hideType?: boolean;
};
export function AgentProgressLine({
  agentType,
  description,
  name,
  descriptionColor,
  taskDescription,
  toolUseCount,
  tokens,
  color,
  isLast,
  isResolved,
  isAsync = false,
  lastToolInfo,
  hideType = false
}: Props) {
  const treeChar = isLast ? "\u2514\u2500" : "\u251C\u2500";
  const isBackgrounded = isAsync && isResolved;
  const getStatusText = () => {
    if (!isResolved) {
      return lastToolInfo || "Initializing\u2026";
    }
    if (isBackgrounded) {
      return taskDescription ?? "Running in the background";
    }
    return "Done";
  };
  return <Box flexDirection="column">{<Box paddingLeft={3}>{<Text dimColor={true}>{treeChar} </Text>}{<Text dimColor={!isResolved}>{hideType ? <><Text bold={true}>{name ?? description ?? agentType}</Text>{name && description && <Text dimColor={true}>: {description}</Text>}</> : <><Text bold={true} backgroundColor={color} color={color ? "inverseText" : undefined}>{agentType}</Text>{description && <>{" ("}<Text backgroundColor={descriptionColor} color={descriptionColor ? "inverseText" : undefined}>{description}</Text>{")"}</>}</>}{!isBackgrounded && <>{" \xB7 "}{toolUseCount} tool {toolUseCount === 1 ? "use" : "uses"}{tokens !== null && <> · {formatNumber(tokens)} tokens</>}</>}</Text>}</Box>}{!isBackgrounded && <Box paddingLeft={3} flexDirection="row"><Text dimColor={true}>{isLast ? "   \u23BF  " : "\u2502  \u23BF  "}</Text><Text dimColor={true}>{getStatusText()}</Text></Box>}</Box>;
}
