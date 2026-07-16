// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import * as React from 'react'
import { Suspense, useState } from 'react'
import { tSync } from '../../i18n/index.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import { useExitOnCtrlCDWithKeybindings } from '../../hooks/useExitOnCtrlCDWithKeybindings.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { useIsInsideModal, useModalOrTerminalSize } from '../../context/ModalContext.js'
import { Pane } from '../design-system/Pane.js'
import { Tabs, Tab } from '../design-system/Tabs.js'
import { Status, buildDiagnostics } from './Status.js'
import { Config } from './Config.js'
import { Usage } from './Usage.js'
import { StatsTab, createAllTimeStatsPromise } from './StatsTab.js'
import type { LocalJSXCommandContext, CommandResultDisplay } from '../../commands.js'
type Props = {
  onClose: (
    result?: string,
    options?: {
      display?: CommandResultDisplay
    },
  ) => void
  context: LocalJSXCommandContext
  defaultTab: 'Status' | 'Config' | 'Usage' | 'Stats' | 'Gates'
}
export function Settings({ onClose, context, defaultTab }: Props) {
  const [selectedTab, setSelectedTab] = useState(defaultTab)
  const [tabsHidden, setTabsHidden] = useState(false)
  const [configOwnsEsc, setConfigOwnsEsc] = useState(false)
  const [gatesOwnsEsc, _setGatesOwnsEsc] = useState(false)
  const insideModal = useIsInsideModal()
  const { rows } = useModalOrTerminalSize(useTerminalSize())
  const contentHeight = insideModal ? rows + 1 : Math.max(15, Math.min(Math.floor(rows * 0.8), 30))
  const [diagnosticsPromise] = useState(() => buildDiagnostics().catch(() => []))
  const [allTimeStatsPromise] = useState(createAllTimeStatsPromise)
  useExitOnCtrlCDWithKeybindings()
  const handleEscape = () => {
    if (tabsHidden) {
      return
    }
    onClose(tSync('settings.dismissed'), {
      display: 'system',
    })
  }
  useKeybinding('confirm:no', handleEscape, {
    context: 'Settings',
    isActive:
      !tabsHidden &&
      !(selectedTab === 'Config' && configOwnsEsc) &&
      !(selectedTab === 'Gates' && gatesOwnsEsc),
  })
  const tabs = [
    <Tab key="status" id="Status" title={tSync('settings.statusTab')}>
      {/* biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容 */}
      <Status context={context} diagnosticsPromise={diagnosticsPromise} />
    </Tab>,
    <Tab key="config" id="Config" title={tSync('settings.configTab')}>
      <Suspense fallback={null}>
        <Config
          // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
          context={context}
          onClose={onClose}
          setTabsHidden={setTabsHidden}
          onIsSearchModeChange={setConfigOwnsEsc}
          contentHeight={contentHeight}
        />
      </Suspense>
    </Tab>,
    <Tab key="usage" id="Usage" title={tSync('settings.usageTab')}>
      <Usage />
    </Tab>,
    <Tab key="stats" id="Stats" title={tSync('settings.statsTab')}>
      <Suspense fallback={null}>
        <StatsTab allTimeStatsPromise={allTimeStatsPromise} />
      </Suspense>
    </Tab>,
    // Gates tab is disabled (behind false flag)
  ] as React.ReactElement[]
  return (
    <Pane color="permission">
      {/* @ts-ignore - Tabs children type mismatch */}
      <Tabs
        color="permission"
        selectedTab={selectedTab}
        onTabChange={setSelectedTab as React.Dispatch<React.SetStateAction<string>>}
        hidden={tabsHidden}
        initialHeaderFocused={true}
        contentHeight={tabsHidden || insideModal ? undefined : contentHeight}
      >
        {tabs}
      </Tabs>
    </Pane>
  )
}
