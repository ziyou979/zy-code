import { tSync } from 'src/i18n/index.js'
import { getMcpConfigsByScope } from 'src/services/mcp/config.js'
import type { ConfigScope } from 'src/services/mcp/types.js'
import { describeMcpConfigFilePath, getScopeLabel } from 'src/services/mcp/utils.js'
import type { ValidationError } from 'src/utils/settings/validation.js'
import { Box, Link, Text } from '../../ink.js'

function McpConfigErrorSection({
  scope,
  parsingErrors,
  warnings,
}: {
  scope: ConfigScope
  parsingErrors: ValidationError[]
  warnings: ValidationError[]
}) {
  const hasErrors = parsingErrors.length > 0
  const hasWarnings = warnings.length > 0
  if (!hasErrors && !hasWarnings) {
    return null
  }
  const scopeLabel = getScopeLabel(scope)
  const configFilePath = describeMcpConfigFilePath(scope)
  const errorElements = parsingErrors.map((error, i) => {
    const serverName = error.mcpErrorMetadata?.serverName
    return (
      <Box key={`error-${i}`}>
        <Text>
          <Text dimColor={true}>└ </Text>
          <Text color="error">{tSync('mcp.errorLabel')}</Text>
          <Text dimColor={true}>
            {' '}
            {serverName && `[${serverName}] `}
            {error.path && error.path !== '' ? `${error.path}: ` : ''}
            {error.message}
          </Text>
        </Text>
      </Box>
    )
  })
  const warningElements = warnings.map((warning, i_0) => {
    const serverName_0 = warning.mcpErrorMetadata?.serverName
    return (
      <Box key={`warning-${i_0}`}>
        <Text>
          <Text dimColor={true}>└ </Text>
          <Text color="warning">{tSync('mcp.warningLabel')}</Text>
          <Text dimColor={true}>
            {' '}
            {serverName_0 && `[${serverName_0}] `}
            {warning.path && warning.path !== '' ? `${warning.path}: ` : ''}
            {warning.message}
          </Text>
        </Text>
      </Box>
    )
  })
  return (
    <Box flexDirection="column" marginTop={1}>
      {
        <Box>
          {(hasErrors || hasWarnings) && (
            <Text color={hasErrors ? 'error' : 'warning'}>
              [{hasErrors ? tSync('mcp.failedToParse') : tSync('mcp.containsWarnings')}]{' '}
            </Text>
          )}
          {<Text>{scopeLabel}</Text>}
        </Box>
      }
      {
        <Box>
          {<Text dimColor={true}>{tSync('mcp.locationLabel')} </Text>}
          <Text dimColor={true}>{configFilePath}</Text>
        </Box>
      }
      {
        <Box marginLeft={1} flexDirection="column">
          {errorElements}
          {warningElements}
        </Box>
      }
    </Box>
  )
}
export function McpParsingWarnings() {
  const scopes = [
    {
      scope: 'user',
      config: getMcpConfigsByScope('user'),
    },
    {
      scope: 'project',
      config: getMcpConfigsByScope('project'),
    },
    {
      scope: 'local',
      config: getMcpConfigsByScope('local'),
    },
    {
      scope: 'enterprise',
      config: getMcpConfigsByScope('enterprise'),
    },
  ] satisfies Array<{
    scope: ConfigScope
    config: {
      errors: ValidationError[]
    }
  }>
  const hasParsingErrors = scopes.some((scopeEntry) => {
    const { config } = scopeEntry
    return filterErrors(config.errors, 'fatal').length > 0
  })
  const hasWarnings = scopes.some((scopeEntry) => {
    const { config: config_0 } = scopeEntry
    return filterErrors(config_0.errors, 'warning').length > 0
  })
  if (!hasParsingErrors && !hasWarnings) {
    return null
  }
  return (
    <Box flexDirection="column" marginTop={1} marginBottom={1}>
      {<Text bold={true}>{tSync('mcp.configDiagnostics')}</Text>}
      <Box marginTop={1}>
        <Text dimColor={true}>
          {tSync('mcp.configDiagnosticsHelp')}{' '}
          <Link url="https://code.zy.com/docs/en/mcp">https://code.zy.com/docs/en/mcp</Link>
        </Text>
      </Box>
      {scopes.map((scopeEntry) => {
        const { scope, config: config_1 } = scopeEntry
        return (
          <McpConfigErrorSection
            key={scope}
            scope={scope}
            parsingErrors={filterErrors(config_1.errors, 'fatal')}
            warnings={filterErrors(config_1.errors, 'warning')}
          />
        )
      })}
    </Box>
  )
}
function filterErrors(errors: ValidationError[], severity: 'fatal' | 'warning'): ValidationError[] {
  return errors.filter((e) => e.mcpErrorMetadata?.severity === severity)
}
