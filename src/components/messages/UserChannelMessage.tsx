import type { TextBlockParam } from '@anthropic-ai/sdk/resources/index.mjs';
import * as React from 'react';
import { CHANNEL_ARROW } from '../../constants/figures.js';
import { CHANNEL_TAG } from '../../constants/xml.js';
import { Box, Text } from '../../ink.js';
import { truncateToWidth } from '../../utils/format.js';
type Props = {
  addMargin: boolean;
  param: TextBlockParam;
};

// <channel source="..." user="..." chat_id="...">content</channel>
// source is always first (wrapChannelMessage writes it), user is optional.
const CHANNEL_RE = new RegExp(`<${CHANNEL_TAG}\\s+source="([^"]+)"([^>]*)>\\n?([\\s\\S]*?)\\n?</${CHANNEL_TAG}>`);
const USER_ATTR_RE = /\buser="([^"]+)"/;

// Plugin-provided servers get names like plugin:slack-channel:slack via
// addPluginScopeToServers — show just the leaf. Matches the suffix-match
// logic in isServerInChannels.
function displayServerName(name: string): string {
  const i = name.lastIndexOf(':');
  return i === -1 ? name : name.slice(i + 1);
}
const TRUNCATE_AT = 60;
export function UserChannelMessage({
  addMargin,
  param: t1
}) {
  const {
    text
  } = t1;
  let T0;
  let T1;
  let T2;
  let t2;
  let t3;
  let t5;
  let t6;
  let t7;
  let truncated;
  let user;
  t7 = Symbol.for("react.early_return_sentinel");
  const m = CHANNEL_RE.exec(text);
  if (!m) {
    t7 = null;
  } else {
    const [, source, attrs, content] = m;
    user = USER_ATTR_RE.exec(attrs ?? "")?.[1];
    const body = (content ?? "").trim().replace(/\s+/g, " ");
    truncated = truncateToWidth(body, TRUNCATE_AT);
    T2 = Box;
    t6 = addMargin ? 1 : 0;
    T1 = Text;
    const t4 = <Text color="suggestion">{CHANNEL_ARROW}</Text>;
    t5 = " ";
    T0 = Text;
    t2 = true;
    t3 = displayServerName(source ?? "");
  }
  if (t7 !== Symbol.for("react.early_return_sentinel")) {
    return t7;
  }
  return <T2 marginTop={t6}>{<T1>{t4}{t5}{<T0 dimColor={t2}>{t3}{user ? ` \u00b7 ${user}` : ""}:</T0>}{" "}{truncated}</T1>}</T2>;
}
