import React from 'react';
import { logError } from 'src/utils/log.js';
import { getOriginalCwd } from '../../../bootstrap/state.js';
import { Box, Text } from '../../../ink.js';
import { sanitizeToolNameForAnalytics } from '../../../services/analytics/metadata.js';
import { SKILL_TOOL_NAME } from '../../../tools/SkillTool/constants.js';
import { SkillTool } from '../../../tools/SkillTool/SkillTool.js';
import { env } from '../../../utils/env.js';
import { shouldShowAlwaysAllowOptions } from '../../../utils/permissions/permissionsLoader.js';
import { logUnaryEvent } from '../../../utils/unaryLogging.js';
import { usePermissionRequestLogging } from '../hooks.js';
import { PermissionDialog } from '../PermissionDialog.js';
import { PermissionPrompt } from '../PermissionPrompt.js';
import { PermissionRuleExplanation } from '../PermissionRuleExplanation.js';
import { tSync } from 'src/i18n/index.js';
type SkillOptionValue = 'yes' | 'yes-exact' | 'yes-prefix' | 'no';
export function SkillPermissionRequest(props) {
  const {
    toolUseConfirm,
    onDone,
    onReject,
    workerBadge
  } = props;
  const parseInput = input => {
    const result = SkillTool.inputSchema.safeParse(input);
    if (!result.success) {
      logError(new Error(`Failed to parse skill tool input: ${result.error.message}`));
      return "";
    }
    return result.data.skill;
  };
  const skill = parseInput(toolUseConfirm.input);
  const commandObj = toolUseConfirm.permissionResult.behavior === "ask" && toolUseConfirm.permissionResult.metadata && "command" in toolUseConfirm.permissionResult.metadata ? toolUseConfirm.permissionResult.metadata.command : undefined;
  const unaryEvent = {
    completion_type: "tool_use_single",
    language_name: "none"
  };
  usePermissionRequestLogging(toolUseConfirm, unaryEvent);
  const originalCwd = getOriginalCwd();
  const showAlwaysAllowOptions = shouldShowAlwaysAllowOptions();
  const baseOptions = [{
    label: tSync('permission.yes'),
    value: "yes",
    feedbackConfig: {
      type: "accept"
    }
  }];
  const alwaysAllowOptions = [];
  if (showAlwaysAllowOptions) {
    alwaysAllowOptions.push({
      label: <Text>{tSync('permission.yesDontAskAgainInCwd', { name: skill, cwd: originalCwd })}</Text>,
      value: "yes-exact"
    });
    const spaceIndex = skill.indexOf(" ");
    if (spaceIndex > 0) {
      const commandPrefix = skill.substring(0, spaceIndex);
      alwaysAllowOptions.push({
        label: <Text>{tSync('permission.yesDontAskAgainCommands', { name: commandPrefix + ":*", cwd: originalCwd })}</Text>,
        value: "yes-prefix"
      });
    }
  }
  const noOption = {
    label: tSync('permission.no'),
    value: "no",
    feedbackConfig: {
      type: "reject"
    }
  };
  const options = [...baseOptions, ...alwaysAllowOptions, noOption];
  const t7 = sanitizeToolNameForAnalytics(toolUseConfirm.tool.name);
  const toolAnalyticsContext = {
    toolName: t7,
    isMcp: toolUseConfirm.tool.isMcp ?? false
  };
  const handleSelect = (value, feedback) => {
    switch (value) {
      case "yes":
        {
          logUnaryEvent({
            completion_type: "tool_use_single",
            event: "accept",
            metadata: {
              language_name: "none",
              message_id: toolUseConfirm.assistantMessage.message.id,
              platform: env.platform
            }
          });
          toolUseConfirm.onAllow(toolUseConfirm.input, [], feedback);
          onDone();
          break;
        }
      case "yes-exact":
        {
          logUnaryEvent({
            completion_type: "tool_use_single",
            event: "accept",
            metadata: {
              language_name: "none",
              message_id: toolUseConfirm.assistantMessage.message.id,
              platform: env.platform
            }
          });
          toolUseConfirm.onAllow(toolUseConfirm.input, [{
            type: "addRules",
            rules: [{
              toolName: SKILL_TOOL_NAME,
              ruleContent: skill
            }],
            behavior: "allow",
            destination: "localSettings"
          }]);
          onDone();
          break;
        }
      case "yes-prefix":
        {
          logUnaryEvent({
            completion_type: "tool_use_single",
            event: "accept",
            metadata: {
              language_name: "none",
              message_id: toolUseConfirm.assistantMessage.message.id,
              platform: env.platform
            }
          });
          const spaceIndex_0 = skill.indexOf(" ");
          const commandPrefix_0 = spaceIndex_0 > 0 ? skill.substring(0, spaceIndex_0) : skill;
          toolUseConfirm.onAllow(toolUseConfirm.input, [{
            type: "addRules",
            rules: [{
              toolName: SKILL_TOOL_NAME,
              ruleContent: `${commandPrefix_0}:*`
            }],
            behavior: "allow",
            destination: "localSettings"
          }]);
          onDone();
          break;
        }
      case "no":
        {
          logUnaryEvent({
            completion_type: "tool_use_single",
            event: "reject",
            metadata: {
              language_name: "none",
              message_id: toolUseConfirm.assistantMessage.message.id,
              platform: env.platform
            }
          });
          toolUseConfirm.onReject(feedback);
          onReject();
          onDone();
        }
    }
  };
  const handleCancel = () => {
    logUnaryEvent({
      completion_type: "tool_use_single",
      event: "reject",
      metadata: {
        language_name: "none",
        message_id: toolUseConfirm.assistantMessage.message.id,
        platform: env.platform
      }
    });
    toolUseConfirm.onReject();
    onReject();
    onDone();
  };
  const t14 = commandObj?.description;
  return <PermissionDialog title={tSync('skills.permission.useSkill', { skill })} workerBadge={workerBadge}>{<Text>{tSync('skills.permission.mayUse')}</Text>}{<Box flexDirection="column" paddingX={2} paddingY={1}><Text dimColor={true}>{t14}</Text></Box>}{<Box flexDirection="column">{<PermissionRuleExplanation permissionResult={toolUseConfirm.permissionResult} toolType="tool" />}{<PermissionPrompt options={options} onSelect={handleSelect} onCancel={handleCancel} toolAnalyticsContext={toolAnalyticsContext} />}</Box>}</PermissionDialog>;
}
