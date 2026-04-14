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

// 插件提供的服务器通过 addPluginScopeToServers 获得类似 plugin:slack-channel:slack 的名称
// ——仅显示叶子节点。与 isServerInChannels 中的后缀匹配逻辑一致。
function displayServerName(name: string): string {
  const i = name.lastIndexOf(':');
  return i === -1 ? name : name.slice(i + 1);
}
const TRUNCATE_AT = 60;
export function UserChannelMessage({
  addMargin,
  param
}) {
  const {
    text
  } = param;
  let TextComponent;
  let TextComponent2;
  let BoxComponent;

  let displayServerNameResult;

  let conditionalValue;
  let earlyReturn;
  let truncated;
  let user;
  earlyReturn = Symbol.for("react.early_return_sentinel");
  const m = CHANNEL_RE.exec(text);
  if (!m) {
    earlyReturn = null;
  } else {
    const [, source, attrs, content] = m;
    user = USER_ATTR_RE.exec(attrs ?? "")?.[1];
    const body = (content ?? "").trim().replace(/\s+/g, " ");
    truncated = truncateToWidth(body, TRUNCATE_AT);
    BoxComponent = Box;
    conditionalValue = addMargin ? 1 : 0;
    TextComponent2 = Text;
    const textElement = <Text color="suggestion">{CHANNEL_ARROW}</Text>;

    TextComponent = Text;

    displayServerNameResult = displayServerName(source ?? "");
  }
  if (earlyReturn !== Symbol.for("react.early_return_sentinel")) {
    return earlyReturn;
  }
  return <BoxComponent marginTop={conditionalValue}>{<TextComponent2>{textElement}{" "}{<TextComponent dimColor={true}>{displayServerNameResult}{user ? ` \u00b7 ${user}` : ""}:</TextComponent>}{" "}{truncated}</TextComponent2>}</BoxComponent>;
}