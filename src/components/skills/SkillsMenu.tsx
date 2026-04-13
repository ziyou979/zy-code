import capitalize from 'lodash-es/capitalize.js';
import * as React from 'react';
import { useMemo } from 'react';
import { type Command, type CommandBase, type CommandResultDisplay, getCommandName, type PromptCommand } from '../../commands.js';
import { Box, Text } from '../../ink.js';
import { estimateSkillFrontmatterTokens, getSkillsPath } from '../../skills/loadSkillsDir.js';
import { getDisplayPath } from '../../utils/file.js';
import { formatTokens } from '../../utils/format.js';
import { getSettingSourceName, type SettingSource } from '../../utils/settings/constants.js';
import { plural } from '../../utils/stringUtils.js';
import { ConfigurableShortcutHint } from '../ConfigurableShortcutHint.js';
import { Dialog } from '../design-system/Dialog.js';

// Skills are always PromptCommands with CommandBase properties
type SkillCommand = CommandBase & PromptCommand;
type SkillSource = SettingSource | 'plugin' | 'mcp';
type Props = {
  onExit: (result?: string, options?: {
    display?: CommandResultDisplay;
  }) => void;
  commands: Command[];
};
function getSourceTitle(source: SkillSource): string {
  if (source === 'plugin') {
    return 'Plugin skills';
  }
  if (source === 'mcp') {
    return 'MCP skills';
  }
  return `${capitalize(getSettingSourceName(source))} skills`;
}
function getSourceSubtitle(source: SkillSource, skills: SkillCommand[]): string | undefined {
  // MCP skills show server names; file-based skills show filesystem paths.
  // Skill names are `<server>:<skill>`, not `mcp__<server>__…`.
  if (source === 'mcp') {
    const servers = [...new Set(skills.map(s => {
      const idx = s.name.indexOf(':');
      return idx > 0 ? s.name.slice(0, idx) : null;
    }).filter((n): n is string => n != null))];
    return servers.length > 0 ? servers.join(', ') : undefined;
  }
  const skillsPath = getDisplayPath(getSkillsPath(source, 'skills'));
  const hasCommandsSkills = skills.some(s => s.loadedFrom === 'commands_DEPRECATED');
  return hasCommandsSkills ? `${skillsPath}, ${getDisplayPath(getSkillsPath(source, 'commands'))}` : skillsPath;
}
export function SkillsMenu({
  onExit,
  commands
}: Props) {
  const skills = commands.filter(cmd => cmd.type === "prompt" && (cmd.loadedFrom === "skills" || cmd.loadedFrom === "commands_DEPRECATED" || cmd.loadedFrom === "plugin" || cmd.loadedFrom === "mcp"));
  const groups = {
    policySettings: [],
    userSettings: [],
    projectSettings: [],
    localSettings: [],
    flagSettings: [],
    plugin: [],
    mcp: []
  };
  for (const skill of skills) {
    const source = skill.source as SkillSource;
    if (source in groups) {
      groups[source].push(skill);
    }
  }
  for (const group of Object.values(groups)) {
    group.sort((a, b) => getCommandName(a).localeCompare(getCommandName(b)));
  }
  const skillsBySource = groups;
  const handleCancel = () => {
    onExit("Skills dialog dismissed", {
      display: "system"
    });
  };
  if (skills.length === 0) {
    return <Dialog title="Skills" subtitle="No skills found" onCancel={handleCancel} hideInputGuide={true}>{<Text dimColor={true}>Create skills in .zy/skills/ or ~/.zy/skills/</Text>}{<Text dimColor={true} italic={true}><ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="close" /></Text>}</Dialog>;
  }
  const renderSkill = skill_0 => {
    const estimatedTokens = estimateSkillFrontmatterTokens(skill_0);
    const tokenDisplay = `~${formatTokens(estimatedTokens)}`;
    const pluginName = skill_0.source === "plugin" ? skill_0.pluginInfo?.pluginManifest.name : undefined;
    return <Box key={`${skill_0.name}-${skill_0.source}`}><Text>{getCommandName(skill_0)}</Text><Text dimColor={true}>{pluginName ? ` · ${pluginName}` : ""} · {tokenDisplay} description tokens</Text></Box>;
  };
  const renderSkillGroup = source_0 => {
    const groupSkills = skillsBySource[source_0];
    if (groupSkills.length === 0) {
      return null;
    }
    const title = getSourceTitle(source_0);
    const subtitle = getSourceSubtitle(source_0, groupSkills);
    return <Box flexDirection="column" key={source_0}><Box><Text bold={true} dimColor={true}>{title}</Text>{subtitle && <Text dimColor={true}> ({subtitle})</Text>}</Box>{groupSkills.map(skill_1 => renderSkill(skill_1))}</Box>;
  };
  const t5 = plural(skills.length, "skill");
  const t7 = renderSkillGroup("projectSettings");
  const t8 = renderSkillGroup("userSettings");
  const t9 = renderSkillGroup("policySettings");
  const t10 = renderSkillGroup("plugin");
  const t11 = renderSkillGroup("mcp");
  return <Dialog title="Skills" subtitle={`${skills.length} ${t5}`} onCancel={handleCancel} hideInputGuide={true}>{<Box flexDirection="column" gap={1}>{t7}{t8}{t9}{t10}{t11}</Box>}{<Text dimColor={true} italic={true}><ConfigurableShortcutHint action="confirm:no" context="Confirmation" fallback="Esc" description="close" /></Text>}</Dialog>;
}
