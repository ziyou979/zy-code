import * as React from 'react'
import { resetCostState } from 'src/bootstrap/runtime/runtimeContext.js'
import { clearTrustedDeviceToken, enrollTrustedDevice } from '../../bridge/trustedDevice.js'
import type { LocalJSXCommandContext } from '../../commands/index.js'
import { ConfigurableShortcutHint } from '../../components/ConfigurableShortcutHint.js'
import { ConsoleOAuthFlow } from '../../components/ConsoleOAuthFlow.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js'
import { tSync } from '../../i18n/index.js'
import { Text } from '../../ink/index.js'
import { refreshGrowthBookAfterAuthChange } from '../../services/analytics/growthbook.js'
import { refreshPolicyLimits } from '../../services/policy-limits/index.js'
import { refreshRemoteManagedSettings } from '../../services/remote-managed-settings/index.js'
import type { LocalJSXCommandOnDone } from '../types.js'
import { stripSignatureBlocks } from '../../services/messages/./prune.js'
import {
  checkAndDisableAutoModeIfNeeded,
  checkAndDisableBypassPermissionsIfNeeded,
  resetAutoModeGateCheck,
  resetBypassPermissionsCheck,
} from '../../services/permissions/bypassPermissionsKillswitch.js'
import { resetUserCache } from '../../services/auth/user.js'
export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
): Promise<React.ReactNode> {
  return (
    <Login
      onDone={async (success, _model, credentialType) => {
        context.onChangeAPIKey()
        if (success) {
          // ADC 校验或刷新不切换 Anthropic 账户，不能顺带删除 Gemini 历史思考签名。
          if (credentialType !== 'google-adc') {
            context.setMessages(stripSignatureBlocks)
          }
          // Post-login refresh logic. Keep in sync with onboarding in src/InteractiveHelpers.tsx
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
  onDone: (success: boolean, model?: string, credentialType?: 'google-adc') => void
  startingMessage?: string
}) {
  const mainLoopModel = useMainLoopModel()
  const [inputActive, setInputActive] = React.useState(false)
  const [setupActive, setSetupActive] = React.useState(false)
  return (
    <Dialog
      title={tSync('login.title')}
      onCancel={() => props.onDone(false, mainLoopModel)}
      color="permission"
      isCancelActive={!inputActive && !setupActive}
      hideInputGuide={setupActive}
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
      <ConsoleOAuthFlow
        onDone={(credentialType) => props.onDone(true, mainLoopModel, credentialType)}
        startingMessage={props.startingMessage}
        onInputModeChange={setInputActive}
        onSetupModeChange={setSetupActive}
      />
    </Dialog>
  )
}
