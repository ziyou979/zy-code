import React, { useMemo, useState } from 'react';
import type { CommandResultDisplay, LocalJSXCommandContext } from '../../commands.js';
import { type OptionWithDescription, Select } from '../../components/CustomSelect/select.js';
import { Dialog } from '../../components/design-system/Dialog.js';
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js';
import { logEvent } from '../../services/analytics/index.js';
import { useZyAiLimits } from '../../services/zyAiLimitsHook.js';
import type { ToolUseContext } from '../../Tool.js';
import type { LocalJSXCommandOnDone } from '../../types/command.js';
import { getOauthAccountInfo, getRateLimitTier } from '../../utils/auth.js';
import { hasZyAiBillingAccess } from '../../utils/billing.js';
import { call as extraUsageCall } from '../extra-usage/extra-usage.js';
import { extraUsage } from '../extra-usage/index.js';
import upgrade from '../upgrade/index.js';
import { call as upgradeCall } from '../upgrade/upgrade.js';
type RateLimitOptionsMenuOptionType = 'upgrade' | 'extra-usage' | 'cancel';
type RateLimitOptionsMenuProps = {
  onDone: (result?: string, options?: {
    display?: CommandResultDisplay | undefined;
  } | undefined) => void;
  context: ToolUseContext & LocalJSXCommandContext;
};
function RateLimitOptionsMenu({
  onDone,
  context
}: RateLimitOptionsMenuProps) {
  const [subCommandJSX, setSubCommandJSX] = useState(null);
  const zyAiLimits = useZyAiLimits();
  const rateLimitTier = getRateLimitTier();
  const hasExtraUsageEnabled = getOauthAccountInfo()?.hasExtraUsageEnabled === true;
  const isMax20x = false;
  const isTeamOrEnterprise = false;
  const buyFirst = getFeatureValue_CACHED_MAY_BE_STALE("tengu_jade_anvil_4", false);
  let options;
  const actionOptions = [];
  if (extraUsage.isEnabled()) {
    const hasBillingAccess = hasZyAiBillingAccess();
    const needsToRequestFromAdmin = isTeamOrEnterprise && !hasBillingAccess;
    const isOrgSpendCapDepleted = zyAiLimits.overageDisabledReason === "out_of_credits" || zyAiLimits.overageDisabledReason === "org_level_disabled_until" || zyAiLimits.overageDisabledReason === "org_service_zero_credit_limit";
    if (needsToRequestFromAdmin && isOrgSpendCapDepleted) {} else {
      const isOverageState = zyAiLimits.overageStatus === "rejected" || zyAiLimits.overageStatus === "allowed_warning";
      let label;
      if (needsToRequestFromAdmin) {
        label = isOverageState ? "Request more" : "Request extra usage";
      } else {
        label = hasExtraUsageEnabled ? "Add funds to continue with extra usage" : "Switch to extra usage";
      }
      actionOptions.push({
        label,
        value: "extra-usage"
      });
    }
  }
  if (!isMax20x && !isTeamOrEnterprise && upgrade.isEnabled()) {
    actionOptions.push({
      label: "Upgrade your plan",
      value: "upgrade"
    });
  }
  const cancelOption = {
    label: "Stop and wait for limit to reset",
    value: "cancel"
  };
  if (buyFirst) {
    options = [...actionOptions, cancelOption];
  } else {
    options = [cancelOption, ...actionOptions];
  }
  const handleCancel = function handleCancel() {
    logEvent("tengu_rate_limit_options_menu_cancel", {});
    onDone(undefined, {
      display: "skip"
    });
  };
  const handleSelect = function handleSelect(value) {
    if (value === "upgrade") {
      logEvent("tengu_rate_limit_options_menu_select_upgrade", {});
      upgradeCall(onDone, context).then(jsx => {
        if (jsx) {
          setSubCommandJSX(jsx);
        }
      });
    } else {
      if (value === "extra-usage") {
        logEvent("tengu_rate_limit_options_menu_select_extra_usage", {});
        extraUsageCall(onDone, context).then(jsx_0 => {
          if (jsx_0) {
            setSubCommandJSX(jsx_0);
          }
        });
      } else {
        if (value === "cancel") {
          handleCancel();
        }
      }
    }
  };
  if (subCommandJSX) {
    return subCommandJSX;
  }
  return <Dialog title="What do you want to do?" onCancel={handleCancel} color="suggestion">{<Select options={options} onChange={handleSelect} visibleOptionCount={options.length} />}</Dialog>;
}
export async function call(onDone: LocalJSXCommandOnDone, context: ToolUseContext & LocalJSXCommandContext): Promise<React.ReactNode> {
  return <RateLimitOptionsMenu onDone={onDone} context={context} />;
}
