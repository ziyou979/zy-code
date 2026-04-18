import figures from 'figures';
import * as React from 'react';
import { Suspense, use } from 'react';
import { getSessionId } from '../../bootstrap/state.js';
import type { LocalJSXCommandContext } from '../../commands.js';
import { useIsInsideModal } from '../../context/modalContext.js';
import { tSync } from '../../i18n/index.js';
import { Box, Text, useTheme } from '../../ink.js';
import { type AppState, useAppState } from '../../state/AppState.js';
import { getCwd } from '../../utils/cwd.js';
import { getCurrentSessionTitle } from '../../utils/sessionStorage.js';
import { buildAccountProperties, buildAPIProviderProperties, buildIDEProperties, buildInstallationDiagnostics, buildInstallationHealthDiagnostics, buildMcpProperties, buildMemoryDiagnostics, buildSandboxProperties, buildSettingSourcesProperties, type Diagnostic, getModelDisplayLabel, type Property } from '../../utils/status.js';
import type { ThemeName } from '../../utils/theme.js';
import { ConfigurableShortcutHint } from '../ConfigurableShortcutHint.js';
type Props = {
  context: LocalJSXCommandContext;
  diagnosticsPromise: Promise<Diagnostic[]>;
};
function buildPrimarySection(): Property[] {
  const sessionId = getSessionId();
  const customTitle = getCurrentSessionTitle(sessionId);
  const nameValue = customTitle ?? <Text dimColor>{tSync('status.noName')}</Text>;
  return [{
    label: tSync('status.version'),
    value: MACRO.VERSION
  }, {
    label: tSync('status.sessionName'),
    value: nameValue
  }, {
    label: tSync('status.sessionId'),
    value: sessionId
  }, {
    label: tSync('status.cwd'),
    value: getCwd()
  }, ...buildAccountProperties(), ...buildAPIProviderProperties()];
}
function buildSecondarySection({
  mainLoopModel,
  mcp,
  theme,
  context
}: {
  mainLoopModel: AppState['mainLoopModel'];
  mcp: AppState['mcp'];
  theme: ThemeName;
  context: LocalJSXCommandContext;
}): Property[] {
  const modelLabel = getModelDisplayLabel(mainLoopModel);
  return [{
    label: tSync('status.model'),
    value: modelLabel
  }, ...buildIDEProperties(mcp.clients, context.options.ideInstallationStatus, theme), ...buildMcpProperties(mcp.clients, theme), ...buildSandboxProperties(), ...buildSettingSourcesProperties()];
}
export async function buildDiagnostics(): Promise<Diagnostic[]> {
  return [...(await buildInstallationDiagnostics()), ...(await buildInstallationHealthDiagnostics()), ...(await buildMemoryDiagnostics())];
}
function PropertyValue({
  value
}) {
  if (Array.isArray(value)) {
    const t1 = value.map((item, i) => <Text key={i}>{item}{i < value.length - 1 ? "," : ""}</Text>);
    return <Box flexWrap="wrap" columnGap={1} flexShrink={99}>{t1}</Box>;
  }
  if (typeof value === "string") {
    return <Text>{value}</Text>;
  }
  return value;
}
export function Status({
  context,
  diagnosticsPromise
}) {
  const mainLoopModel = useAppState(s => s.mainLoopModel);
  const mcp = useAppState(s_0 => s_0.mcp);
  const [theme] = useTheme();
  const t1 = buildPrimarySection();
  const t2 = buildSecondarySection({
    mainLoopModel,
    mcp,
    theme,
    context
  });
  const sections = [t1, t2];
  const grow = useIsInsideModal() ? 1 : undefined;
  const t4 = sections.map((properties, i) => properties.length > 0 && <Box key={i} flexDirection="column">{properties.map((t0, j) => {
      const {
        label,
        value
      } = t0;
      return <Box key={j} flexDirection="row" gap={1} flexShrink={0}>{label !== undefined && <Text bold={true}>{label}:</Text>}<PropertyValue value={value} /></Box>;
    })}</Box>);
  return <Box flexDirection="column" flexGrow={grow}>{<Box flexDirection="column" gap={1} flexGrow={grow}>{t4}{<Suspense fallback={null}><Diagnostics promise={diagnosticsPromise} /></Suspense>}</Box>}{<Text dimColor={true}><ConfigurableShortcutHint action="confirm:no" context="Settings" fallback="Esc" description="cancel" /></Text>}</Box>;
}
function Diagnostics({
  promise
}) {
  const diagnostics = use(promise);
  if ((diagnostics as any).length === 0) {
    return null;
  }
  const t2 = (diagnostics as any).map((diagnostic: any, i: number) => <Box key={i} flexDirection="row" gap={1} paddingX={1}><Text color="error">{figures.warning}</Text>{typeof diagnostic === "string" ? <Text wrap="wrap">{diagnostic}</Text> : diagnostic}</Box>);
  return <Box flexDirection="column" paddingBottom={1}>{<Text bold={true}>{tSync('status.diagnostics')}</Text>}{t2}</Box>;
}
