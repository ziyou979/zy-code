import { WARNING } from '../../constants/figures.js'
import { Suspense, use } from 'react'
import { getSessionId } from '../../bootstrap/state.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import { useIsInsideModal } from '../../context/modalContext.js'
import { tSync } from '../../i18n/index.js'
import { Box, Text, useTheme } from '../../ink.js'
import { getExtensionInventory } from '../../services/diagnostics/extensionInventory.js'
import { type AppState, useAppState } from '../../state/AppState.js'
import { getCwd } from '../../utils/cwd.js'
import { getCurrentSessionTitle } from '../../utils/sessionStorage.js'
import {
  buildAccountProperties,
  buildAPIProviderProperties,
  buildIDEProperties,
  buildInstallationDiagnostics,
  buildInstallationHealthDiagnostics,
  buildMcpProperties,
  buildMemoryDiagnostics,
  buildSandboxProperties,
  buildSettingSourcesProperties,
  type Diagnostic,
  getModelDisplayLabel,
  type Property,
} from '../../utils/status.js'
import type { ThemeName } from '../../utils/theme.js'
import { ConfigurableShortcutHint } from '../ConfigurableShortcutHint.js'

type Props = {
  context: LocalJSXCommandContext
  diagnosticsPromise: Promise<Diagnostic[]>
}
function buildPrimarySection(): Property[] {
  const sessionId = getSessionId()
  const customTitle = getCurrentSessionTitle(sessionId)
  const nameValue = customTitle ?? <Text dimColor>{tSync('status.noName')}</Text>
  return [
    {
      label: tSync('status.version'),
      value: MACRO.VERSION,
    },
    {
      label: tSync('status.sessionName'),
      value: nameValue,
    },
    {
      label: tSync('status.sessionId'),
      value: sessionId,
    },
    {
      label: tSync('status.cwd'),
      value: getCwd(),
    },
    ...buildAccountProperties(),
    ...buildAPIProviderProperties(),
  ]
}
function buildSecondarySection({
  mainLoopModel,
  mcp,
  theme,
  context,
}: {
  mainLoopModel: AppState['mainLoopModel']
  mcp: AppState['mcp']
  theme: ThemeName
  context: LocalJSXCommandContext
}): Property[] {
  const modelLabel = getModelDisplayLabel(mainLoopModel)
  return [
    {
      label: tSync('status.model'),
      value: modelLabel,
    },
    ...buildIDEProperties(mcp.clients, context.options.ideInstallationStatus, theme),
    ...buildMcpProperties(mcp.clients, theme),
    ...buildSandboxProperties(),
    ...buildSettingSourcesProperties(),
  ]
}
export async function buildDiagnostics(): Promise<Diagnostic[]> {
  return [
    ...(await buildInstallationDiagnostics()),
    ...(await buildInstallationHealthDiagnostics()),
    ...(await buildMemoryDiagnostics()),
  ]
}
// biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
function PropertyValue({ value }: { value: any }) {
  if (Array.isArray(value)) {
    const textItems = value.map((item, i) => (
      <Text key={i}>
        {item}
        {i < value.length - 1 ? ',' : ''}
      </Text>
    ))
    return (
      <Box flexWrap="wrap" columnGap={1} flexShrink={99}>
        {textItems}
      </Box>
    )
  }
  if (typeof value === 'string') {
    return <Text>{value}</Text>
  }
  return value
}
export function Status({ context, diagnosticsPromise }: Props) {
  const mainLoopModel = useAppState((s) => s.mainLoopModel)
  const mcp = useAppState((state) => state.mcp)
  const [theme] = useTheme()
  const primarySection = buildPrimarySection()
  const secondarySection = buildSecondarySection({
    mainLoopModel,
    mcp,
    theme,
    context,
  })
  const extensionsPromise = getExtensionInventory(getCwd())
  const sections = [primarySection, secondarySection]
  const grow = useIsInsideModal() ? 1 : undefined
  const sectionElements = sections.map(
    (properties, i) =>
      properties.length > 0 && (
        <Box key={i} flexDirection="column">
          {properties.map((property, j) => {
            const { label, value } = property
            return (
              <Box key={j} flexDirection="row" gap={1} flexShrink={0}>
                {label !== undefined && <Text bold={true}>{label}:</Text>}
                <PropertyValue value={value} />
              </Box>
            )
          })}
        </Box>
      ),
  )
  return (
    <Box flexDirection="column" flexGrow={grow}>
      {
        <Box flexDirection="column" gap={1} flexGrow={grow}>
          {sectionElements}
          {
            <Suspense fallback={null}>
              <Diagnostics promise={diagnosticsPromise} />
            </Suspense>
          }
          {
            <Suspense fallback={null}>
              <Extensions promise={extensionsPromise} />
            </Suspense>
          }
        </Box>
      }
      {
        <Text dimColor={true}>
          <ConfigurableShortcutHint
            action="confirm:no"
            context="Settings"
            fallback="Esc"
            description="cancel"
          />
        </Text>
      }
    </Box>
  )
}
// biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
function Diagnostics({ promise }: { promise: Promise<any> }) {
  const diagnostics = use(promise)
  // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
  if ((diagnostics as any).length === 0) {
    return null
  }
  // biome-ignore lint/suspicious/noExplicitAny: UI 组件动态类型兼容
  const diagnosticElements = (diagnostics as any).map((diagnostic: any, i: number) => (
    <Box key={i} flexDirection="row" gap={1} paddingX={1}>
      <Text color="error">{WARNING}</Text>
      {typeof diagnostic === 'string' ? <Text wrap="wrap">{diagnostic}</Text> : diagnostic}
    </Box>
  ))
  return (
    <Box flexDirection="column" paddingBottom={1}>
      {<Text bold={true}>{tSync('status.diagnostics')}</Text>}
      {diagnosticElements}
    </Box>
  )
}

function Extensions({
  promise,
}: {
  promise: Promise<import('../../services/diagnostics/extensionInventory.js').ExtensionInventory>
}) {
  const inventory = use(promise)
  const parts: string[] = []
  if (inventory.commands.length) {
    parts.push(`${inventory.commands.length} ${tSync('status.extensions.commands')}`)
  }
  if (inventory.tools.length) {
    parts.push(`${inventory.tools.length} ${tSync('status.extensions.tools')}`)
  }
  if (inventory.plugins.length) {
    parts.push(`${inventory.plugins.length} ${tSync('status.extensions.plugins')}`)
  }
  if (inventory.skills.length) {
    parts.push(`${inventory.skills.length} ${tSync('status.extensions.skills')}`)
  }
  if (inventory.mcp.length) {
    parts.push(`${inventory.mcp.length} ${tSync('status.extensions.mcp')}`)
  }
  if (!parts.length) {
    return null
  }
  return (
    <Box flexDirection="row" gap={1} flexShrink={0}>
      <Text bold={true}>{tSync('status.extensions')}:</Text>
      <Text>{parts.join(', ')}</Text>
    </Box>
  )
}
