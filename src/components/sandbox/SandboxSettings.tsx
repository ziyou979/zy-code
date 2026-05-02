import React from 'react'
import { Box, color, Link, Text, useTheme } from '../../ink.js'
import { useKeybindings } from '../../keybindings/useKeybinding.js'
import type { CommandResultDisplay } from '../../types/command.js'
import type { SandboxDependencyCheck } from '../../utils/sandbox/sandbox-adapter.js'
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js'
import { getSettings_DEPRECATED } from '../../utils/settings/settings.js'
import { Select } from '../CustomSelect/select.js'
import { Pane } from '../design-system/Pane.js'
import { Tab, Tabs, useTabHeaderFocus } from '../design-system/Tabs.js'
import { SandboxConfigTab } from './SandboxConfigTab.js'
import { SandboxDependenciesTab } from './SandboxDependenciesTab.js'
import { SandboxOverridesTab } from './SandboxOverridesTab.js'
type Props = {
  onComplete: (
    result?: string,
    options?: {
      display?: CommandResultDisplay
    },
  ) => void
  depCheck: SandboxDependencyCheck
}
type SandboxModeTabProps = {
  showSocketWarning: boolean
  options: { label: string; value: string }[]
  onSelect: (value: any) => Promise<void>
  onComplete: (result?: string, options?: { display?: CommandResultDisplay }) => void
}
type SandboxMode = 'auto-allow' | 'regular' | 'disabled'
export function SandboxSettings({ onComplete, depCheck }: Props) {
  const [theme] = useTheme()
  const currentEnabled = SandboxManager.isSandboxingEnabled()
  const currentAutoAllow = SandboxManager.isAutoAllowBashIfSandboxedEnabled()
  const hasWarnings = depCheck.warnings.length > 0
  const settings = getSettings_DEPRECATED()
  const allowAllUnixSockets = settings.sandbox?.network?.allowAllUnixSockets
  const showSocketWarning = hasWarnings && !allowAllUnixSockets
  const getCurrentMode = () => {
    if (!currentEnabled) {
      return 'disabled'
    }
    if (currentAutoAllow) {
      return 'auto-allow'
    }
    return 'regular'
  }
  const currentMode = getCurrentMode()
  const currentIndicator = color('success', theme)('(current)')
  const options = [
    {
      label:
        currentMode === 'auto-allow'
          ? `Sandbox BashTool, with auto-allow ${currentIndicator}`
          : 'Sandbox BashTool, with auto-allow',
      value: 'auto-allow',
    },
    {
      label:
        currentMode === 'regular'
          ? `Sandbox BashTool, with regular permissions ${currentIndicator}`
          : 'Sandbox BashTool, with regular permissions',
      value: 'regular',
    },
    {
      label: currentMode === 'disabled' ? `No Sandbox ${currentIndicator}` : 'No Sandbox',
      value: 'disabled',
    },
  ]
  const handleSelect = async function handleSelect(value) {
    const mode = value as SandboxMode
    switch (mode) {
      case 'auto-allow': {
        await SandboxManager.setSandboxSettings({
          enabled: true,
          autoAllowBashIfSandboxed: true,
        })
        onComplete('\u2713 Sandbox enabled with auto-allow for bash commands')
        break
      }
      case 'regular': {
        await SandboxManager.setSandboxSettings({
          enabled: true,
          autoAllowBashIfSandboxed: false,
        })
        onComplete('\u2713 Sandbox enabled with regular bash permissions')
        break
      }
      case 'disabled': {
        await SandboxManager.setSandboxSettings({
          enabled: false,
          autoAllowBashIfSandboxed: false,
        })
        onComplete('\u25CB Sandbox disabled')
      }
    }
  }
  useKeybindings(
    {
      'confirm:no': () =>
        onComplete(undefined, {
          display: 'skip',
        }),
    },
    {
      context: 'Settings',
    },
  )
  const modeTab = (
    <Tab key="mode" title="Mode">
      <SandboxModeTab
        showSocketWarning={showSocketWarning}
        options={options}
        onSelect={handleSelect}
        onComplete={onComplete}
      />
    </Tab>
  )
  const overridesTab = (
    <Tab key="overrides" title="Overrides">
      <SandboxOverridesTab onComplete={onComplete} />
    </Tab>
  )
  const configTab = (
    <Tab key="config" title="Config">
      <SandboxConfigTab />
    </Tab>
  )
  const hasErrors = depCheck.errors.length > 0
  const tabs = hasErrors
    ? [
        <Tab key="dependencies" title="Dependencies">
          <SandboxDependenciesTab depCheck={depCheck} />
        </Tab>,
      ]
    : [
        modeTab,
        ...(hasWarnings
          ? [
              <Tab key="dependencies" title="Dependencies">
                <SandboxDependenciesTab depCheck={depCheck} />
              </Tab>,
            ]
          : []),
        overridesTab,
        configTab,
      ]
  return (
    <Pane color="permission">
      <Tabs title="Sandbox:" color="permission" defaultTab="Mode">
        {tabs}
      </Tabs>
    </Pane>
  )
}
function SandboxModeTab({ showSocketWarning, options, onSelect, onComplete }: SandboxModeTabProps) {
  const { headerFocused, focusHeader } = useTabHeaderFocus()
  return (
    <Box flexDirection="column" paddingY={1}>
      {showSocketWarning && (
        <Box marginBottom={1}>
          <Text color="warning">Cannot block unix domain sockets (see Dependencies tab)</Text>
        </Box>
      )}
      {
        <Box marginBottom={1}>
          <Text bold={true}>Configure Mode:</Text>
        </Box>
      }
      {
        <Select
          options={options}
          onChange={onSelect}
          onCancel={() =>
            onComplete(undefined, {
              display: 'skip',
            })
          }
          onUpFromFirstItem={focusHeader}
          isDisabled={headerFocused}
        />
      }
      {
        <Box flexDirection="column" marginTop={1} gap={1}>
          {
            <Text dimColor={true}>
              <Text bold={true} dimColor={true}>
                Auto-allow mode:
              </Text>{' '}
              Commands will try to run in the sandbox automatically, and attempts to run outside of
              the sandbox fallback to regular permissions. Explicit ask/deny rules are always
              respected.
            </Text>
          }
          <Text dimColor={true}>
            Learn more:{' '}
            <Link url="https://code.zy.com/docs/en/sandboxing">code.zy.com/docs/en/sandboxing</Link>
          </Text>
        </Box>
      }
    </Box>
  )
}
