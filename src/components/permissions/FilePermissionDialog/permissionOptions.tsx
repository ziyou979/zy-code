import { homedir } from 'node:os'
import { basename, join, sep } from 'node:path'
import { type ReactNode } from 'react'
import { tSync } from 'src/i18n/index.js'
import { getOriginalCwd } from '../../../bootstrap/runtime/runtimeContext.js'
import { Text } from '../../../ink.js'
import { getShortcutDisplay } from '../../../keybindings/shortcutFormat.js'
import type { ToolPermissionContext } from '../../../tools/Tool.js'
import { expandPath, getDirectoryForPath } from '../../../utils/path.js'
import {
  normalizeCaseForComparison,
  pathInAllowedWorkingPath,
} from '../../../services/permissions/filesystem.js'
import type { OptionWithDescription } from '../../CustomSelect/select.js'
/**
 * Check if a path is within the project's .zy/ folder.
 * This is used to determine whether to show the special ".zy folder" permission option.
 */
export function isInZyFolder(filePath: string): boolean {
  const absolutePath = expandPath(filePath)
  const ZyFolderPath = expandPath(`${getOriginalCwd()}/.zy`)

  // Check if the path is within the project's .zy folder
  const normalizedAbsolutePath = normalizeCaseForComparison(absolutePath)
  const normalizedZyFolderPath = normalizeCaseForComparison(ZyFolderPath)

  // Path must start with the .zy folder path (and be inside it, not just the folder itself)
  return (
    normalizedAbsolutePath.startsWith(normalizedZyFolderPath + sep.toLowerCase()) ||
    // Also match case where sep is / on posix systems
    normalizedAbsolutePath.startsWith(`${normalizedZyFolderPath}/`)
  )
}

/**
 * Check if a path is within the global ~/.zy/ folder.
 * This is used to determine whether to show the special ".zy folder" permission option
 * for files in the user's home directory.
 */
export function isInGlobalZyFolder(filePath: string): boolean {
  const absolutePath = expandPath(filePath)
  const globalZyFolderPath = join(homedir(), '.zy')
  const normalizedAbsolutePath = normalizeCaseForComparison(absolutePath)
  const normalizedGlobalZyFolderPath = normalizeCaseForComparison(globalZyFolderPath)
  return (
    normalizedAbsolutePath.startsWith(normalizedGlobalZyFolderPath + sep.toLowerCase()) ||
    normalizedAbsolutePath.startsWith(`${normalizedGlobalZyFolderPath}/`)
  )
}
export type PermissionOption =
  | {
      type: 'accept-once'
    }
  | {
      type: 'accept-session'
      scope?: 'zy-folder' | 'global-zy-folder'
    }
  | {
      type: 'reject'
    }
export type PermissionOptionWithLabel = OptionWithDescription<string> & {
  option: PermissionOption
}
export type FileOperationType = 'read' | 'write' | 'create'
export function getFilePermissionOptions({
  filePath,
  toolPermissionContext,
  operationType = 'write',
  onRejectFeedbackChange,
  onAcceptFeedbackChange,
  yesInputMode = false,
  noInputMode = false,
}: {
  filePath: string
  toolPermissionContext: ToolPermissionContext
  operationType?: FileOperationType
  onRejectFeedbackChange?: (value: string) => void
  onAcceptFeedbackChange?: (value: string) => void
  yesInputMode?: boolean
  noInputMode?: boolean
}): PermissionOptionWithLabel[] {
  const options: PermissionOptionWithLabel[] = []
  const modeCycleShortcut = getShortcutDisplay('chat:cycleMode', 'Chat', 'shift+tab')

  // When in input mode, show input field
  if (yesInputMode && onAcceptFeedbackChange) {
    options.push({
      type: 'input',
      label: tSync('permission.yes'),
      value: 'yes',
      placeholder: tSync('permission.tellZyNext'),
      onChange: onAcceptFeedbackChange,
      allowEmptySubmitToCancel: true,
      option: {
        type: 'accept-once',
      },
    })
  } else {
    options.push({
      label: tSync('permission.yes'),
      value: 'yes',
      option: {
        type: 'accept-once',
      },
    })
  }
  const inAllowedPath = pathInAllowedWorkingPath(filePath, toolPermissionContext)

  // Check if this is a .zy/ folder path (project or global)
  const inZyFolder = isInZyFolder(filePath)
  const inGlobalZyFolder = isInGlobalZyFolder(filePath)

  // Option 2: For .zy/ folder, show special option instead of generic session option
  // Note: Session-level options are always shown since they only affect in-memory state,
  // not persisted settings. The allowManagedPermissionRulesOnly setting only restricts
  // persisted permission rules.
  if ((inZyFolder || inGlobalZyFolder) && operationType !== 'read') {
    options.push({
      label: tSync('permission.yesAllowZyFolderEdits'),
      value: 'yes-zy-folder',
      option: {
        type: 'accept-session',
        scope: inGlobalZyFolder ? 'global-zy-folder' : 'zy-folder',
      },
    })
  } else {
    // Option 2: Allow all changes/reads during session
    let sessionLabel: ReactNode
    if (inAllowedPath) {
      // Inside working directory
      if (operationType === 'read') {
        sessionLabel = tSync('permission.yesAllowReadThisSession')
      } else {
        sessionLabel = (
          <Text>
            {tSync('permission.yesAllowEditsThisSession', { shortcut: modeCycleShortcut })}
          </Text>
        )
      }
    } else {
      // Outside working directory - include directory name
      const dirPath = getDirectoryForPath(filePath)
      const dirName = basename(dirPath) || 'this directory'
      if (operationType === 'read') {
        sessionLabel = <Text>{tSync('permission.yesAllowReadFromDir', { dir: dirName })}</Text>
      } else {
        sessionLabel = (
          <Text>
            {tSync('permission.yesAllowEditsInDir', { dir: dirName, shortcut: modeCycleShortcut })}
          </Text>
        )
      }
    }
    options.push({
      label: sessionLabel,
      value: 'yes-session',
      option: {
        type: 'accept-session',
      },
    })
  }

  // When in input mode, show input field for reject
  if (noInputMode && onRejectFeedbackChange) {
    options.push({
      type: 'input',
      label: tSync('permission.no'),
      value: 'no',
      placeholder: tSync('permission.tellZyDifferently'),
      onChange: onRejectFeedbackChange,
      allowEmptySubmitToCancel: true,
      option: {
        type: 'reject',
      },
    })
  } else {
    // Not in input mode - simple option
    options.push({
      label: tSync('permission.no'),
      value: 'no',
      option: {
        type: 'reject',
      },
    })
  }
  return options
}
