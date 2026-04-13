import figures from 'figures';
import React from 'react';
import { Box, Text } from '../../ink.js';
import type { AdvisorBlock } from '../../utils/advisor.js';
import { renderModelName } from '../../utils/model/model.js';
import { jsonStringify } from '../../utils/slowOperations.js';
import { CtrlOToExpand } from '../CtrlOToExpand.js';
import { MessageResponse } from '../MessageResponse.js';
import { ToolUseLoader } from '../ToolUseLoader.js';
type Props = {
  block: AdvisorBlock;
  addMargin: boolean;
  resolvedToolUseIDs: Set<string>;
  erroredToolUseIDs: Set<string>;
  shouldAnimate: boolean;
  verbose: boolean;
  advisorModel?: string;
};
export function AdvisorMessage({
  block,
  addMargin,
  resolvedToolUseIDs,
  erroredToolUseIDs,
  shouldAnimate,
  verbose,
  advisorModel
}: Props) {
  if (block.type === "server_tool_use") {
    const input = block.input && Object.keys(block.input).length > 0 ? jsonStringify(block.input) : null;
    const t3 = resolvedToolUseIDs.has(block.id);
    const t5 = erroredToolUseIDs.has(block.id);
    return <Box marginTop={addMargin ? 1 : 0} paddingRight={2} flexDirection="row">{<ToolUseLoader shouldAnimate={shouldAnimate} isUnresolved={!t3} isError={t5} />}{<Text bold={true}>Advising</Text>}{advisorModel ? <Text dimColor={true}> using {renderModelName(advisorModel)}</Text> : null}{input ? <Text dimColor={true}> · {input}</Text> : null}</Box>;
  }
  let body;
  switch (block.content.type) {
    case "advisor_tool_result_error":
      {
        let t1;
        t1 = <Text color="error">Advisor unavailable ({block.content.error_code})</Text>;
        body = t1;
        break;
      }
    case "advisor_result":
      {
        let t1;
        t1 = verbose ? <Text dimColor={true}>{block.content.text}</Text> : <Text dimColor={true}>{figures.tick} Advisor has reviewed the conversation and will apply the feedback <CtrlOToExpand /></Text>;
        body = t1;
        break;
      }
    case "advisor_redacted_result":
      {
        let t1;
        t1 = <Text dimColor={true}>{figures.tick} Advisor has reviewed the conversation and will apply the feedback</Text>;
        body = t1;
      }
  }
  return <Box paddingRight={2}><MessageResponse>{body}</MessageResponse></Box>;
}
