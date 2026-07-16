import { COMMAND_MESSAGE_TAG, COMMAND_NAME_TAG } from '../../constants/xml.js'
import type { CommandBase, PromptCommand } from 'src/commands.js'

/**
 * Determines if a string looks like a valid command name.
 * Valid command names only contain letters, numbers, colons, hyphens, and underscores.
 */
export function looksLikeCommand(commandName: string): boolean {
  // Command names should only contain [a-zA-Z0-9:_-]
  // If it contains other characters, it's probably a file path or other input
  return !/[^a-zA-Z0-9:\-_]/.test(commandName)
}

/**
 * Formats the metadata for a skill loading message.
 * Used by the Skill tool and for subagent skill preloading.
 */
export function formatSkillLoadingMetadata(
  skillName: string,
  _progressMessage: string = 'loading',
): string {
  return [
    `<${COMMAND_MESSAGE_TAG}>${skillName}</${COMMAND_MESSAGE_TAG}>`,
    `<${COMMAND_NAME_TAG}>${skillName}</${COMMAND_NAME_TAG}>`,
    `<skill-format>true</skill-format>`,
  ].join('\n')
}

/**
 * Formats the metadata for a slash command loading message.
 */
function formatSlashCommandLoadingMetadata(commandName: string, args?: string): string {
  return [
    `<${COMMAND_MESSAGE_TAG}>${commandName}</${COMMAND_MESSAGE_TAG}>`,
    `<${COMMAND_NAME_TAG}>/${commandName}</${COMMAND_NAME_TAG}>`,
    args ? `<command-args>${args}</command-args>` : null,
  ]
    .filter(Boolean)
    .join('\n')
}

/**
 * Formats the loading metadata for a command (skill or slash command).
 * User-invocable skills use slash command format (/name), while model-only
 * skills use the skill format ("The X skill is running").
 */
export function formatCommandLoadingMetadata(
  command: CommandBase & PromptCommand,
  args?: string,
): string {
  // User-invocable skills should show as /command-name like regular slash commands
  if (command.userInvocable !== false) {
    return formatSlashCommandLoadingMetadata(command.name, args)
  }
  // Model-only skills (userInvocable: false) show as "The X skill is running"
  if (
    command.loadedFrom === 'skills' ||
    command.loadedFrom === 'plugin' ||
    command.loadedFrom === 'mcp'
  ) {
    return formatSkillLoadingMetadata(command.name, command.progressMessage)
  }
  return formatSlashCommandLoadingMetadata(command.name, args)
}
