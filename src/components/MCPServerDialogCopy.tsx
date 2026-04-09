import { c as _c } from "react/compiler-runtime";
import React from 'react';
import { tSync } from '../i18n/index.js';
import { Link, Text } from '../ink.js';
export function MCPServerDialogCopy() {
  const $ = _c(1);
  let t0;
  if ($[0] === Symbol.for("react.memo_cache_sentinel")) {
    t0 = <Text>{tSync('mcpServer.warning')}</Text>;
    $[0] = t0;
  } else {
    t0 = $[0];
  }
  return t0;
}
