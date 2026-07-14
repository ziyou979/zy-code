import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../services/analytics/index.js'
import { logEvent } from '../services/analytics/index.js'
import { teleportToRemote, type TeleportToRemoteResponse } from '../services/teleport/teleport.js'
import {
  getTeleportErrors,
  type TeleportLocalErrorType,
} from '../services/teleport/prerequisites.js'
import type { Root } from '../ink.js'
import { KeybindingSetup } from '../keybindings/KeybindingProviderSetup.js'
import { AppStateProvider } from '../state/AppState.js'
import { TeleportError } from './TeleportError.js'

async function handleTeleportPrerequisites(
  root: Root,
  errorsToIgnore?: Set<TeleportLocalErrorType>,
): Promise<void> {
  const errors = await getTeleportErrors()
  if (errors.size === 0) return

  logEvent('zy_teleport_errors_detected', {
    error_types: Array.from(errors).join(
      ',',
    ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    errors_ignored: Array.from(errorsToIgnore ?? []).join(
      ',',
    ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })

  await new Promise<void>((resolve) => {
    root.render(
      <AppStateProvider>
        <KeybindingSetup>
          <TeleportError
            errorsToIgnore={errorsToIgnore}
            onComplete={() => {
              logEvent('zy_teleport_errors_resolved', {
                error_types: Array.from(errors).join(
                  ',',
                ) as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
              })
              resolve()
            }}
          />
        </KeybindingSetup>
      </AppStateProvider>,
    )
  })
}

/** 在现有 Ink root 中完成前置交互后创建远程会话。 */
export async function teleportToRemoteWithErrorHandling(
  root: Root,
  description: string | null,
  signal: AbortSignal,
  branchName?: string,
): Promise<TeleportToRemoteResponse | null> {
  await handleTeleportPrerequisites(root, new Set<TeleportLocalErrorType>(['needsGitStash']))
  return teleportToRemote({
    initialMessage: description,
    signal,
    branchName,
    onBundleFail: (message) => process.stderr.write(`\n${message}\n`),
  })
}
