import chalk from 'chalk'
import React, { useEffect } from 'react'
import {
  getAdditionalDirectoriesForAgentsMd,
  setAdditionalDirectoriesForAgentsMd,
} from 'src/bootstrap/runtime/runtimeContext.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import { MessageResponse } from '../../components/MessageResponse.js'
import { AddWorkspaceDirectory } from '../../components/permissions/rules/AddWorkspaceDirectory.js'
import { POINTER } from '../../constants/figures.js'
import { Box, Text } from '../../ink.js'
import { SandboxManager } from '../../services/sandbox/sandbox-adapter.js'
import type { LocalJSXCommandOnDone } from '../types.js'
import {
  applyPermissionUpdate,
  persistPermissionUpdate,
} from '../../services/permissions/permissionUpdate.js'
import type { PermissionUpdateDestination } from '../../services/permissions/permissionUpdateSchema.js'
import { addDirHelpMessage, validateDirectoryForWorkspace } from './validation.js'

function AddDirError({
  message,
  args,
  onDone,
}: {
  message: string
  args: string
  onDone: () => void
}) {
  useEffect(() => {
    const timer = setTimeout(onDone, 0)
    return () => clearTimeout(timer)
  }, [onDone])
  return (
    <Box flexDirection="column">
      {
        <Text dimColor={true}>
          {POINTER} /add-dir {args}
        </Text>
      }
      {
        <MessageResponse>
          <Text>{message}</Text>
        </MessageResponse>
      }
    </Box>
  )
}
export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args?: string,
): Promise<React.ReactNode> {
  const directoryPath = (args ?? '').trim()
  const appState = context.getAppState()

  // Helper to handle adding a directory (shared by both with-path and no-path cases)
  const handleAddDirectory = async (path: string, remember = false) => {
    const destination: PermissionUpdateDestination = remember ? 'localSettings' : 'session'
    const permissionUpdate = {
      type: 'addDirectories' as const,
      directories: [path],
      destination,
    }

    // Apply to session context
    const latestAppState = context.getAppState()
    const updatedContext = applyPermissionUpdate(
      latestAppState.toolPermissionContext,
      permissionUpdate,
    )
    context.setAppState((prev) => ({
      ...prev,
      toolPermissionContext: updatedContext,
    }))

    // Update sandbox config so Bash commands can access the new directory.
    // Bootstrap state is the source of truth for session-only dirs; persisted
    // dirs are picked up via the settings subscription, but we refresh
    // eagerly here to avoid a race when the user acts immediately.
    const currentDirs = getAdditionalDirectoriesForAgentsMd()
    if (!currentDirs.includes(path)) {
      setAdditionalDirectoriesForAgentsMd([...currentDirs, path])
    }
    SandboxManager.refreshConfig()
    let message: string
    if (remember) {
      try {
        persistPermissionUpdate(permissionUpdate)
        message = `Added ${chalk.bold(path)} as a working directory and saved to local settings`
      } catch (error) {
        message = `Added ${chalk.bold(path)} as a working directory. Failed to save to local settings: ${error instanceof Error ? error.message : 'Unknown error'}`
      }
    } else {
      message = `Added ${chalk.bold(path)} as a working directory for this session`
    }
    const messageWithHint = `${message} ${chalk.dim('· /permissions to manage')}`
    onDone(messageWithHint)
  }

  // When no path is provided, show AddWorkspaceDirectory input form directly
  // and return to REPL after confirmation
  if (!directoryPath) {
    return (
      <AddWorkspaceDirectory
        permissionContext={appState.toolPermissionContext}
        onAddDirectory={handleAddDirectory}
        onCancel={() => {
          onDone('Did not add a working directory.')
        }}
        // biome-ignore lint/suspicious/noExplicitAny: 运行时动态类型处理
        directoryPath={undefined as any}
      />
    )
  }
  const result = await validateDirectoryForWorkspace(directoryPath, appState.toolPermissionContext)
  if (result.resultType !== 'success') {
    const message = addDirHelpMessage(result)
    return <AddDirError message={message} args={args ?? ''} onDone={() => onDone(message)} />
  }
  return (
    <AddWorkspaceDirectory
      directoryPath={result.absolutePath}
      permissionContext={appState.toolPermissionContext}
      onAddDirectory={handleAddDirectory}
      onCancel={() => {
        onDone(`Did not add ${chalk.bold(result.absolutePath)} as a working directory.`)
      }}
    />
  )
}
