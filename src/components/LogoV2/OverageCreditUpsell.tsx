import * as React from 'react';
import { useState } from 'react';
import { Text } from '../../ink.js';
import { logEvent } from '../../services/analytics/index.js';
import { formatGrantAmount, getCachedOverageCreditGrant, refreshOverageCreditGrantCache } from '../../services/api/overageCreditGrant.js';
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js';
import { truncate } from '../../utils/format.js';
import type { FeedConfig } from './Feed.js';
const MAX_IMPRESSIONS = 3;

/**
 * Whether to show the overage credit upsell on any surface.
 *
 * Eligibility comes entirely from the backend GET /overage_credit_grant
 * response — the CLI doesn't replicate tier/threshold/role checks. The
 * backend returns available: false for Team members who aren't admins,
 * so they don't see an upsell they can't act on.
 *
 * isEligibleForOverageCreditGrant — just the backend eligibility. Use for
 *   persistent reference surfaces (/usage) where the info should show
 *   whenever eligible, no impression cap.
 * shouldShowOverageCreditUpsell — adds the 3-impression cap and
 *   hasVisitedExtraUsage dismiss. Use for promotional surfaces
 *   (welcome feed, tips).
 */
export function isEligibleForOverageCreditGrant(): boolean {
  const info = getCachedOverageCreditGrant();
  if (!info || !info.available || info.granted) return false;
  return formatGrantAmount(info) !== null;
}
export function shouldShowOverageCreditUpsell(): boolean {
  if (!isEligibleForOverageCreditGrant()) return false;
  const config = getGlobalConfig();
  if (config.hasVisitedExtraUsage) return false;
  if ((config.overageCreditUpsellSeenCount ?? 0) >= MAX_IMPRESSIONS) return false;
  return true;
}

/**
 * Kick off a background fetch if the cache is empty. Safe to call
 * unconditionally on mount — it no-ops if cache is fresh.
 */
export function maybeRefreshOverageCreditCache(): void {
  if (getCachedOverageCreditGrant() !== null) return;
  void refreshOverageCreditGrantCache();
}
export function useShowOverageCreditUpsell() {
  const [show] = useState(() => {
    maybeRefreshOverageCreditCache();
    return shouldShowOverageCreditUpsell();
  });
  return show;
}
export function incrementOverageCreditUpsellSeenCount(): void {
  let newCount = 0;
  saveGlobalConfig((prev) => {
    newCount = (prev.overageCreditUpsellSeenCount ?? 0) + 1;
    return {
      ...prev,
      overageCreditUpsellSeenCount: newCount
    };
  });
  logEvent('zy_overage_credit_upsell_shown', {
    seen_count: newCount
  });
}

// Copy from "OC & Bulk Overages copy" doc (#6 — CLI /usage)
function getUsageText(amount: string): string {
  return `${amount} in extra usage for third-party apps · /extra-usage`;
}

// Copy from "OC & Bulk Overages copy" doc (#4 — CLI Welcome screen).
// Char budgets: title ≤19, subtitle ≤48.
const FEED_SUBTITLE = 'On us. Works on third-party apps · /extra-usage';
function getFeedTitle(amount: string): string {
  return `${amount} in extra usage`;
}
type Props = {
  maxWidth?: number;
  twoLine?: boolean;
};
export function OverageCreditUpsell({
  maxWidth,
  twoLine
}: Props) {
  let textElement;
  let earlyReturn;
  earlyReturn = Symbol.for("react.early_return_sentinel");
  const info = getCachedOverageCreditGrant();
  if (!info) {
    earlyReturn = null;
  } else {
    const amount = formatGrantAmount(info);
    if (!amount) {
      earlyReturn = null;
    } else if (twoLine) {
      const title = getFeedTitle(amount);
      const truncateResult = maxWidth ? truncate(FEED_SUBTITLE, maxWidth) : FEED_SUBTITLE;
      earlyReturn = <><Text color="zy">{maxWidth ? truncate(title, maxWidth) : title}</Text>{<Text dimColor={true}>{truncateResult}</Text>}</>;
    } else {
      const text = getUsageText(amount);
      const display = maxWidth ? truncate(text, maxWidth) : text;
      const highlightLen = Math.min(getFeedTitle(amount).length, display.length);
      textElement = <Text dimColor={true}><Text color="zy">{display.slice(0, highlightLen)}</Text>{display.slice(highlightLen)}</Text>;
    }
  }
  if (earlyReturn !== Symbol.for("react.early_return_sentinel")) {
    return earlyReturn;
  }
  return textElement;
}

/**
 * Feed config for the homescreen rotating feed. Mirrors
 * createGuestPassesFeed in feedConfigs.tsx.
 *
 * Copy from "OC & Bulk Overages copy" doc (#4 — CLI Welcome screen).
 * Char budgets: title ≤19, subtitle ≤48.
 */
export function createOverageCreditFeed(): FeedConfig {
  const info = getCachedOverageCreditGrant();
  const amount = info ? formatGrantAmount(info) : null;
  const title = amount ? getFeedTitle(amount) : 'extra usage credit';
  return {
    title,
    lines: [],
    customContent: {
      content: <Text dimColor>{FEED_SUBTITLE}</Text>,
      width: Math.max(title.length, FEED_SUBTITLE.length)
    }
  };
}