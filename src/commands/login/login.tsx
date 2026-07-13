import { feature } from 'bun:bundle'
import * as React from 'react'
import { resetCostState } from '../../bootstrap/state.js'
import { clearTrustedDeviceToken, enrollTrustedDevice } from '../../bridge/trustedDevice.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import { ConfigurableShortcutHint } from '../../components/ConfigurableShortcutHint.js'
import { ConsoleOAuthFlow } from '../../components/ConsoleOAuthFlow.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js'
import { tSync } from '../../i18n/index.js'
import { Text } from '../../ink.js'
import { refreshGrowthBookAfterAuthChange } from '../../services/analytics/growthbook.js'
import { refreshPolicyLimits } from '../../services/policy-limits/index.js'
import { refreshRemoteManagedSettings } from '../../services/remote-managed-settings/index.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { stripSignatureBlocks } from '../../utils/messages.js'
import {
  checkAndDisableAutoModeIfNeeded,
  checkAndDisableBypassPermissionsIfNeeded,
  resetAutoModeGateCheck,
  resetBypassPermissionsCheck,
} from '../../utils/permissions/bypassPermissionsKillswitch.js'
import { resetUserCache } from '../../utils/user.js'
export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
): Promise<React.ReactNode> {
  return (
    <Login
      onDone={async (success: boolean) => {
        context.onChangeAPIKey()
        // Signature-bearing blocks (thinking, connector_text) are bound to the API key —
        // strip them so the new key doesn't reject stale signatures.
        context.setMessages(stripSignatureBlocks)
        if (success) {
          // Post-login refresh logic. Keep in sync with onboarding in src/interactiveHelpers.tsx
          // Reset cost state when switching accounts
          resetCostState()
          // Refresh remotely managed settings after login (non-blocking)
          void refreshRemoteManagedSettings()
          // Refresh policy limits after login (non-blocking)
          void refreshPolicyLimits()
          // Clear user data cache BEFORE GrowthBook refresh so it picks up fresh credentials
          resetUserCache()
          // Refresh GrowthBook after login to get updated feature flags (e.g., for zy.ai MCPs)
          refreshGrowthBookAfterAuthChange()
          // Clear any stale trusted device token from a previous account before
          // re-enrolling — prevents sending the old token on bridge calls while
          // the async enrollTrustedDevice() is in-flight.
          clearTrustedDeviceToken()
          // Enroll as a trusted device for Remote Control (10-min fresh-session window)
          void enrollTrustedDevice()
          // Reset killswitch gate checks and re-run with new org
          resetBypassPermissionsCheck()
          const appState = context.getAppState()
          void checkAndDisableBypassPermissionsIfNeeded(
            appState.toolPermissionContext,
            context.setAppState,
          )
          resetAutoModeGateCheck()
          void checkAndDisableAutoModeIfNeeded(appState.toolPermissionContext, context.setAppState)
          // Increment authVersion to trigger re-fetching of auth-dependent data in hooks (e.g., MCP servers)
          context.setAppState((prev) => ({
            ...prev,
            authVersion: prev.authVersion + 1,
          }))
        }
        onDone(success ? tSync('login.successful') : tSync('login.interrupted'))
      }}
    />
  )
}
export function Login(props: {
  onDone: (success: boolean, model?: string) => void
  startingMessage?: string
}) {
  const mainLoopModel = useMainLoopModel()
  return (
    <Dialog
      title={tSync('login.title')}
      onCancel={() => props.onDone(false, mainLoopModel)}
      color="permission"
      inputGuide={(exitState) =>
        exitState.pending ? (
          <Text>{tSync('login.pressAgainExit', { keyName: exitState.keyName ?? '' })}</Text>
        ) : (
          <ConfigurableShortcutHint
            action="confirm:no"
            context="Confirmation"
            fallback="Esc"
            description="cancel"
          />
        )
      }
    >
      {
        <ConsoleOAuthFlow
          onDone={() => props.onDone(true, mainLoopModel)}
          startingMessage={props.startingMessage}
        />
      }
    </Dialog>
  )
}
