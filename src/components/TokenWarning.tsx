import { feature } from 'bun:bundle';
import * as React from 'react';
import { useSyncExternalStore } from 'react';
import { Box, Text } from '../ink.js';
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../services/analytics/growthbook.js';
import { calculateTokenWarningState, getEffectiveContextWindowSize, isAutoCompactEnabled } from '../services/compact/autoCompact.js';
import { useCompactWarningSuppression } from '../services/compact/compactWarningHook.js';
import { getUpgradeMessage } from '../utils/model/contextWindowUpgradeCheck.js';
import { tSync } from '../i18n/index.js';
type Props = {
  tokenUsage: number;
  model: string;
};

/**
 * Live collapse progress: "x / y summarized". Sub-component so
 * useSyncExternalStore can subscribe to store mutations unconditionally
 * (hooks-in-conditionals would violate React rules). The parent only
 * renders this when feature('CONTEXT_COLLAPSE') + isContextCollapseEnabled().
 */
function CollapseLabel(props: Props) {
  const { upgradeMessage } = props as any;
  const t1 = require("../services/contextCollapse/index.js");
  const {
    getStats,
    subscribe
  } = t1 as typeof import('../services/contextCollapse/index.js');
  const snapshot = useSyncExternalStore(subscribe, () => {
    const s = getStats();
    const idleWarn = s.health.emptySpawnWarningEmitted ? 1 : 0;
    return `${s.collapsedSpans}|${s.stagedSpans}|${s.health.totalErrors}|${s.health.totalEmptySpawns}|${idleWarn}`;
  });
  const t3 = snapshot.split("|").map(Number);
  const [collapsed, staged, errors, emptySpawns, idleWarn_0] = t3 as [number, number, number, number, number];
  const total = collapsed + staged;
  if (errors > 0 || idleWarn_0) {
    const problem = errors > 0 ? tSync('tokenWarning.collapseErrors', {
      count: errors
    }) : tSync('tokenWarning.collapseIdle', {
      count: emptySpawns
    });
    return <Text color="warning" wrap="truncate">{total > 0 ? `${tSync('tokenWarning.summarized', {
        collapsed,
        total
      })} \u00b7 ${problem}` : problem}</Text>;
  }
  if (total === 0) {
    return null;
  }
  const label = tSync('tokenWarning.summarized', {
    collapsed,
    total
  });
  return <Text dimColor={true} wrap="truncate">{upgradeMessage ? `${label} \u00b7 ${upgradeMessage}` : label}</Text>;
}
export function TokenWarning({
  tokenUsage,
  model
}: Props) {
  const {
    percentLeft,
    isAboveWarningThreshold,
    isAboveErrorThreshold
  } = calculateTokenWarningState(tokenUsage, model);
  const suppressWarning = useCompactWarningSuppression();
  if (!isAboveWarningThreshold || suppressWarning) {
    return null;
  }
  const showAutoCompactWarning = isAutoCompactEnabled();
  const upgradeMessage = getUpgradeMessage("warning");
  let displayPercentLeft = percentLeft;
  let reactiveOnlyMode = false;
  let collapseMode = false;
  if (feature("REACTIVE_COMPACT")) {
    if (getFeatureValue_CACHED_MAY_BE_STALE("tengu_cobalt_raccoon", false)) {
      reactiveOnlyMode = true;
    }
  }
  if (feature("CONTEXT_COLLAPSE")) {
    const {
      isContextCollapseEnabled
    } = require("../services/contextCollapse/index.js") as typeof import('../services/contextCollapse/index.js');
    if (isContextCollapseEnabled()) {
      collapseMode = true;
    }
  }
  if (reactiveOnlyMode || collapseMode) {
    const effectiveWindow = getEffectiveContextWindowSize(model);
    const t4 = Math.round((effectiveWindow - tokenUsage) / effectiveWindow * 100);
    displayPercentLeft = Math.max(0, t4);
  }
  if (collapseMode && feature("CONTEXT_COLLAPSE")) {
    // @ts-ignore
    return <Box flexDirection="row"><CollapseLabel upgradeMessage={upgradeMessage} /></Box>;
  }
  const autocompactLabel = reactiveOnlyMode ? tSync('tokenWarning.contextUsed', {
    pct: 100 - displayPercentLeft
  }) : tSync('tokenWarning.untilAutoCompact', {
    pct: displayPercentLeft
  });
  const contextLowText = tSync('tokenWarning.contextLow', {
    pct: percentLeft
  });
  const compactAction = tSync('tokenWarning.runCompact');
  return <Box flexDirection="row">{showAutoCompactWarning ? <Text dimColor={true} wrap="truncate">{upgradeMessage ? `${autocompactLabel} \u00b7 ${upgradeMessage}` : autocompactLabel}</Text> : <Text color={isAboveErrorThreshold ? "error" : "warning"} wrap="truncate">{upgradeMessage ? `${contextLowText} \u00b7 ${upgradeMessage}` : `${contextLowText} \u00b7 ${compactAction}`}</Text>}</Box>;
}
