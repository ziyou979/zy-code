import React, { useMemo } from 'react';
import { getMcpConfigsByScope } from 'src/services/mcp/config.js';
import type { ConfigScope } from 'src/services/mcp/types.js';
import { describeMcpConfigFilePath, getScopeLabel } from 'src/services/mcp/utils.js';
import type { ValidationError } from 'src/utils/settings/validation.js';
import { Box, Link, Text } from '../../ink.js';
function McpConfigErrorSection({
  scope,
  parsingErrors,
  warnings
}) {
  const hasErrors = parsingErrors.length > 0;
  const hasWarnings = warnings.length > 0;
  if (!hasErrors && !hasWarnings) {
    return null;
  }
  const t2 = getScopeLabel(scope);
  const t6 = describeMcpConfigFilePath(scope);
  const t8 = parsingErrors.map((error, i) => {
    const serverName = error.mcpErrorMetadata?.serverName;
    return <Box key={`error-${i}`}><Text><Text dimColor={true}>└ </Text><Text color="error">[Error]</Text><Text dimColor={true}>{" "}{serverName && `[${serverName}] `}{error.path && error.path !== "" ? `${error.path}: ` : ""}{error.message}</Text></Text></Box>;
  });
  const t9 = warnings.map((warning, i_0) => {
    const serverName_0 = warning.mcpErrorMetadata?.serverName;
    return <Box key={`warning-${i_0}`}><Text><Text dimColor={true}>└ </Text><Text color="warning">[Warning]</Text><Text dimColor={true}>{" "}{serverName_0 && `[${serverName_0}] `}{warning.path && warning.path !== "" ? `${warning.path}: ` : ""}{warning.message}</Text></Text></Box>;
  });
  return <Box flexDirection="column" marginTop={1}>{<Box>{(hasErrors || hasWarnings) && <Text color={hasErrors ? "error" : "warning"}>[{hasErrors ? "Failed to parse" : "Contains warnings"}]{" "}</Text>}{<Text>{t2}</Text>}</Box>}{<Box>{<Text dimColor={true}>Location: </Text>}<Text dimColor={true}>{t6}</Text></Box>}{<Box marginLeft={1} flexDirection="column">{t8}{t9}</Box>}</Box>;
}
export function McpParsingWarnings() {
  const scopes = [{
    scope: "user",
    config: getMcpConfigsByScope("user")
  }, {
    scope: "project",
    config: getMcpConfigsByScope("project")
  }, {
    scope: "local",
    config: getMcpConfigsByScope("local")
  }, {
    scope: "enterprise",
    config: getMcpConfigsByScope("enterprise")
  }] satisfies Array<{
    scope: ConfigScope;
    config: {
      errors: ValidationError[];
    };
  }>;
  const hasParsingErrors = scopes.some(t0 => {
    const {
      config
    } = t0;
    return filterErrors(config.errors, "fatal").length > 0;
  });
  const hasWarnings = scopes.some(t0 => {
    const {
      config: config_0
    } = t0;
    return filterErrors(config_0.errors, "warning").length > 0;
  });
  if (!hasParsingErrors && !hasWarnings) {
    return null;
  }
  return <Box flexDirection="column" marginTop={1} marginBottom={1}>{<Text bold={true}>MCP Config Diagnostics</Text>}<Box marginTop={1}><Text dimColor={true}>For help configuring MCP servers, see:{" "}<Link url="https://code.zy.com/docs/en/mcp">https://code.zy.com/docs/en/mcp</Link></Text></Box>{scopes.map(t0 => {
      const {
        scope,
        config: config_1
      } = t0;
      return <McpConfigErrorSection key={scope} scope={scope} parsingErrors={filterErrors(config_1.errors, "fatal")} warnings={filterErrors(config_1.errors, "warning")} />;
    })}</Box>;
}
function filterErrors(errors: ValidationError[], severity: 'fatal' | 'warning'): ValidationError[] {
  return errors.filter(e => e.mcpErrorMetadata?.severity === severity);
}
