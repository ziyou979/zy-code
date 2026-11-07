import { tSync } from '../i18n/index.js'
import { ConfigurableShortcutHint } from './ConfigurableShortcutHint.js'
import { envDynamic } from 'src/services/environment/envDynamic.js'
import { Box, Text } from '../ink/index.js'
import { useKeybindings } from '../keybindings/useKeybinding.js'
import { getGlobalConfig, saveGlobalConfig } from '../services/config/config.js'
import { env } from '../services/environment/env.js'
import { getTerminalIdeType, isJetBrainsIde, toIDEDisplayName } from '../services/ide/ideCatalog.js'
import type { IDEExtensionInstallationStatus } from '../services/ide/ide.js'
import { Dialog } from './design-system/Dialog.js'

interface Props {
  onDone: () => void
  installationStatus: IDEExtensionInstallationStatus | null
}
export function IdeOnboardingDialog({ onDone, installationStatus }: Props) {
  markDialogAsShown()
  useKeybindings(
    {
      'confirm:yes': onDone,
      'confirm:no': onDone,
    },
    {
      context: 'Confirmation',
    },
  )
  const ideType = installationStatus?.ideType ?? getTerminalIdeType()
  const isJetBrains = isJetBrainsIde(ideType)
  const ideName = toIDEDisplayName(ideType)
  const installedVersion = installationStatus?.installedVersion
  const mentionShortcut = env.platform === 'darwin' ? 'Cmd+Option+K' : 'Ctrl+Alt+K'
  return (
    <>
      <Dialog
        title={<Text color="zy">✻ {tSync('ideOnboarding.welcome', { ideName })}</Text>}
        subtitle={
          installedVersion
            ? tSync(
                isJetBrains ? 'ideOnboarding.installedPlugin' : 'ideOnboarding.installedExtension',
                { version: installedVersion },
              )
            : undefined
        }
        color="ide"
        onCancel={onDone}
        hideInputGuide
      >
        <Box flexDirection="column" gap={1}>
          <Text>• {tSync('ideOnboarding.context')}</Text>
          <Text>• {tSync('ideOnboarding.review', { added: '+11', removed: '-22' })}</Text>
          <Text>• {tSync('ideOnboarding.quickLaunch', { shortcut: 'Cmd+Esc' })}</Text>
          <Text>• {tSync('ideOnboarding.mention', { shortcut: mentionShortcut })}</Text>
        </Box>
      </Dialog>
      <Box paddingX={2}>
        <Text dimColor italic>
          <ConfigurableShortcutHint
            action="confirm:yes"
            context="Confirmation"
            fallback="Enter"
            description={tSync('common.continue')}
          />
        </Text>
      </Box>
    </>
  )
}

export function hasIdeOnboardingDialogBeenShown(): boolean {
  const config = getGlobalConfig()
  const terminal = envDynamic.terminal || 'unknown'
  return config.hasIdeOnboardingBeenShown?.[terminal] === true
}
function markDialogAsShown(): void {
  if (hasIdeOnboardingDialogBeenShown()) {
    return
  }
  const terminal = envDynamic.terminal || 'unknown'
  saveGlobalConfig((current) => ({
    ...current,
    hasIdeOnboardingBeenShown: {
      ...current.hasIdeOnboardingBeenShown,
      [terminal]: true,
    },
  }))
}
