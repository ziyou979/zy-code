// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import * as React from 'react';
import { Suspense, useState } from 'react';
import { tSync } from '../../i18n/index.js';
import { useKeybinding } from '../../keybindings/useKeybinding.js';
import { useExitOnCtrlCDWithKeybindings } from '../../hooks/useExitOnCtrlCDWithKeybindings.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { useIsInsideModal, useModalOrTerminalSize } from '../../context/modalContext.js';
import { Pane } from '../design-system/Pane.js';
import { Tabs, Tab } from '../design-system/Tabs.js';
import { Status, buildDiagnostics } from './Status.js';
import { Config } from './Config.js';
import { Usage } from './Usage.js';
import type { LocalJSXCommandContext, CommandResultDisplay } from '../../commands.js';
type Props = {
  onClose: (result?: string, options?: {
    display?: CommandResultDisplay;
  }) => void;
  context: LocalJSXCommandContext;
  defaultTab: 'Status' | 'Config' | 'Usage' | 'Gates';
};
export function Settings({
  onClose,
  context,
  defaultTab
}: Props) {
  const [selectedTab, setSelectedTab] = useState(defaultTab);
  const [tabsHidden, setTabsHidden] = useState(false);
  const [configOwnsEsc, setConfigOwnsEsc] = useState(false);
  const [gatesOwnsEsc, setGatesOwnsEsc] = useState(false);
  const insideModal = useIsInsideModal();
  const {
    rows
  } = useModalOrTerminalSize(useTerminalSize());
  const contentHeight = insideModal ? rows + 1 : Math.max(15, Math.min(Math.floor(rows * 0.8), 30));
  const [diagnosticsPromise] = useState(() => buildDiagnostics().catch(() => []));
  useExitOnCtrlCDWithKeybindings();
  const handleEscape = () => {
    if (tabsHidden) {
      return;
    }
    onClose(tSync('settings.dismissed'), {
      display: "system"
    });
  };
  useKeybinding("confirm:no", handleEscape, {
    context: "Settings",
    isActive: !tabsHidden && !(selectedTab === "Config" && configOwnsEsc) && !(selectedTab === "Gates" && gatesOwnsEsc)
  });
  // @ts-ignore - Gates is internal-only and may not be available
  const tabs = [<Tab key="status" title={tSync('settings.statusTab')}><Status context={context as any} diagnosticsPromise={diagnosticsPromise} /></Tab>, <Tab key="config" title={tSync('settings.configTab')}><Suspense fallback={null}><Config context={context as any} onClose={onClose} setTabsHidden={setTabsHidden} onIsSearchModeChange={setConfigOwnsEsc} contentHeight={contentHeight} /></Suspense></Tab>, <Tab key="usage" title={tSync('settings.usageTab')}><Usage /></Tab>, ...(false ? [<Tab key="gates" title={tSync('settings.gatesTab')}><Gates onOwnsEscChange={setGatesOwnsEsc} contentHeight={contentHeight} /></Tab>] : [])] as any;
  return <Pane color="permission"><Tabs color="permission" selectedTab={selectedTab} onTabChange={setSelectedTab as any} hidden={tabsHidden} initialHeaderFocused={defaultTab !== "Config" && defaultTab !== "Gates"} contentHeight={tabsHidden || insideModal ? undefined : contentHeight}>{tabs}</Tabs></Pane>;
}