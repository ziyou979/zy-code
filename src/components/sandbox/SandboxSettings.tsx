import { Box, color, Link, Text, useTheme } from '../../ink/index.js'
import { tSync } from '../../i18n/index.js'
import { useKeybindings } from '../../keybindings/useKeybinding.js'
import type { SandboxDependencyCheck } from '../../services/sandbox/sandboxAdapter.js'
import { SandboxManager } from '../../services/sandbox/sandboxAdapter.js'
import type { CommandResultDisplay } from '../../commands/types.js'
import { getInitialSettings } from '../../services/settings/settings.js'
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
  // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
  onSelect: (value: any) => Promise<void>
  onComplete: (result?: string, options?: { display?: CommandResultDisplay }) => void
}
type SandboxMode = 'auto-allow' | 'regular' | 'disabled'
export function SandboxSettings({ onComplete, depCheck }: Props) {
  const [theme] = useTheme()
  const currentEnabled = SandboxManager.isSandboxingEnabled()
  const currentAutoAllow = SandboxManager.isAutoAllowBashIfSandboxedEnabled()
  const hasWarnings = depCheck.warnings.length > 0
  const settings = getInitialSettings()
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
  const currentIndicator = color('success', theme)(`(${tSync('misc.sandbox.settings.current')})`)
  const options = [
    {
      label:
        currentMode === 'auto-allow'
          ? `${tSync('misc.sandbox.settings.autoAllowLabel')} ${currentIndicator}`
          : tSync('misc.sandbox.settings.autoAllowLabel'),
      value: 'auto-allow',
    },
    {
      label:
        currentMode === 'regular'
          ? `${tSync('misc.sandbox.settings.regularLabel')} ${currentIndicator}`
          : tSync('misc.sandbox.settings.regularLabel'),
      value: 'regular',
    },
    {
      label:
        currentMode === 'disabled'
          ? `${tSync('misc.sandbox.settings.disabledLabel')} ${currentIndicator}`
          : tSync('misc.sandbox.settings.disabledLabel'),
      value: 'disabled',
    },
  ]
  const handleSelect = async function handleSelect(value: string) {
    const mode = value as SandboxMode
    switch (mode) {
      case 'auto-allow': {
        await SandboxManager.setSandboxSettings({
          enabled: true,
          autoAllowBashIfSandboxed: true,
        })
        onComplete(tSync('misc.sandbox.settings.enabledAutoAllow'))
        break
      }
      case 'regular': {
        await SandboxManager.setSandboxSettings({
          enabled: true,
          autoAllowBashIfSandboxed: false,
        })
        onComplete(tSync('misc.sandbox.settings.enabledRegular'))
        break
      }
      case 'disabled': {
        await SandboxManager.setSandboxSettings({
          enabled: false,
          autoAllowBashIfSandboxed: false,
        })
        onComplete(tSync('misc.sandbox.settings.disabled'))
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
    <Tab key="mode" title={tSync('misc.sandbox.settings.tabMode')}>
      <SandboxModeTab
        showSocketWarning={showSocketWarning}
        options={options}
        onSelect={handleSelect}
        onComplete={onComplete}
      />
    </Tab>
  )
  const overridesTab = (
    <Tab key="overrides" title={tSync('misc.sandbox.settings.tabOverrides')}>
      <SandboxOverridesTab onComplete={onComplete} />
    </Tab>
  )
  const configTab = (
    <Tab key="config" title={tSync('misc.sandbox.settings.tabConfig')}>
      <SandboxConfigTab />
    </Tab>
  )
  const hasErrors = depCheck.errors.length > 0
  const tabs = hasErrors
    ? [
        <Tab key="dependencies" title={tSync('misc.sandbox.settings.tabDependencies')}>
          <SandboxDependenciesTab depCheck={depCheck} />
        </Tab>,
      ]
    : [
        modeTab,
        ...(hasWarnings
          ? [
              <Tab key="dependencies" title={tSync('misc.sandbox.settings.tabDependencies')}>
                <SandboxDependenciesTab depCheck={depCheck} />
              </Tab>,
            ]
          : []),
        overridesTab,
        configTab,
      ]
  return (
    <Pane color="permission">
      <Tabs
        title={`${tSync('misc.sandbox.settings.paneTitle')}:`}
        color="permission"
        defaultTab="Mode"
      >
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
          <Text color="warning">{tSync('misc.sandbox.settings.socketWarning')}</Text>
        </Box>
      )}
      {
        <Box marginBottom={1}>
          <Text bold={true}>{tSync('misc.sandbox.settings.configureMode')}:</Text>
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
                {tSync('misc.sandbox.settings.autoAllowMode')}:
              </Text>{' '}
              {tSync('misc.sandbox.settings.autoAllowDesc')}
            </Text>
          }
          <Text dimColor={true}>
            {tSync('misc.sandbox.settings.learnMore')}:{' '}
            <Link url="https://code.zy.com/docs/en/sandboxing">code.zy.com/docs/en/sandboxing</Link>
          </Text>
        </Box>
      }
    </Box>
  )
}
