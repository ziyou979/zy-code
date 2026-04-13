import type { TextBlockParam } from '@anthropic-ai/sdk/resources/index.mjs';
import * as React from 'react';
import { REFRESH_ARROW } from '../../constants/figures.js';
import { Box, Text } from '../../ink.js';
type Props = {
  addMargin: boolean;
  param: TextBlockParam;
};
type ParsedUpdate = {
  kind: 'resource' | 'polling';
  server: string;
  /** URI for resource updates, tool name for polling updates */
  target: string;
  reason?: string;
};

// Parse resource and polling updates from XML format
function parseUpdates(text: string): ParsedUpdate[] {
  const updates: ParsedUpdate[] = [];

  // Match <mcp-resource-update server="..." uri="...">
  const resourceRegex = /<mcp-resource-update\s+server="([^"]+)"\s+uri="([^"]+)"[^>]*>(?:[\s\S]*?<reason>([^<]+)<\/reason>)?/g;
  let match;
  while ((match = resourceRegex.exec(text)) !== null) {
    updates.push({
      kind: 'resource',
      server: match[1] ?? '',
      target: match[2] ?? '',
      reason: match[3]
    });
  }

  // Match <mcp-polling-update type="tool" server="..." tool="...">
  const pollingRegex = /<mcp-polling-update\s+type="([^"]+)"\s+server="([^"]+)"\s+tool="([^"]+)"[^>]*>(?:[\s\S]*?<reason>([^<]+)<\/reason>)?/g;
  while ((match = pollingRegex.exec(text)) !== null) {
    updates.push({
      kind: 'polling',
      server: match[2] ?? '',
      target: match[3] ?? '',
      reason: match[4]
    });
  }
  return updates;
}

// Format URI for display - show just the meaningful part
function formatUri(uri: string): string {
  // For file:// URIs, show just the filename
  if (uri.startsWith('file://')) {
    const path = uri.slice(7);
    const parts = path.split('/');
    return parts[parts.length - 1] || path;
  }
  // For other URIs, show the whole thing but truncated
  if (uri.length > 40) {
    return uri.slice(0, 39) + '\u2026';
  }
  return uri;
}
export function UserResourceUpdateMessage({
  addMargin,
  param: t1
}) {
  const {
    text
  } = t1;
  let T0;
  let t2;
  let t3;
  let t4;
  let t5;
  t5 = Symbol.for("react.early_return_sentinel");
  const updates = parseUpdates(text);
  if (updates.length === 0) {
    t5 = null;
  } else {
    T0 = Box;
    t2 = "column";
    t3 = addMargin ? 1 : 0;
    t4 = updates.map((update, i) => <Box key={i}><Text><Text color="success">{REFRESH_ARROW}</Text>{" "}<Text dimColor={true}>{update.server}:</Text>{" "}<Text color="suggestion">{update.kind === "resource" ? formatUri(update.target) : update.target}</Text>{update.reason && <Text dimColor={true}> · {update.reason}</Text>}</Text></Box>);
  }
  if (t5 !== Symbol.for("react.early_return_sentinel")) {
    return t5;
  }
  return <T0 flexDirection={t2} marginTop={t3}>{t4}</T0>;
}
