import React, { useState } from 'react'
import type { CommandResultDisplay, LocalJSXCommandContext } from '../../commands/index.js'
import { Select } from '../../components/CustomSelect/select.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { tSync } from '../../i18n/index.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { logEvent } from '../../services/analytics/index.js'
import { useZyAiLimits } from '../../services/zyAiLimitsHook.js'
import type { ToolUseContext } from '../../tools/tool.js'
import type { LocalJSXCommandOnDone } from '../types.js'
import { getOauthAccountInfo, getRateLimitTier } from '../../services/auth/auth.js'
import upgrade from '../upgrade/index.js'
import { call as upgradeCall } from '../upgrade/upgrade.js'

type RateLimitOptionsMenuOptionType = 'upgrade' | 'cancel'
type RateLimitOptionsMenuProps = {
  onDone: (
    result?: string,
    options?:
      | {
          display?: CommandResultDisplay | undefined
        }
      | undefined,
  ) => void
  context: ToolUseContext & LocalJSXCommandContext
}
function RateLimitOptionsMenu({ onDone, context }: RateLimitOptionsMenuProps) {
  const [subCommandJSX, setSubCommandJSX] = useState<React.ReactNode>(null)
  const _zyAiLimits = useZyAiLimits()
  const _rateLimitTier = getRateLimitTier()
  const _hasExtraUsageEnabled = getOauthAccountInfo()?.hasExtraUsageEnabled === true
  const isMax20x = false
  const isTeamOrEnterprise = false
  const buyFirst = getFeatureValue_CACHED_MAY_BE_STALE('zy_jade_anvil_4', false)
  let options
  const actionOptions = []
  if (!isMax20x && !isTeamOrEnterprise && upgrade.isEnabled()) {
    actionOptions.push({
      label: tSync('rateLimit.upgradePlan'),
      value: 'upgrade',
    })
  }
  const cancelOption = {
    label: tSync('rateLimit.stopAndWait'),
    value: 'cancel',
  }
  if (buyFirst) {
    options = [...actionOptions, cancelOption]
  } else {
    options = [cancelOption, ...actionOptions]
  }
  const handleCancel = function handleCancel() {
    logEvent('zy_rate_limit_options_menu_cancel', {})
    onDone(undefined, {
      display: 'skip',
    })
  }
  const handleSelect = function handleSelect(value: RateLimitOptionsMenuOptionType) {
    if (value === 'upgrade') {
      logEvent('zy_rate_limit_options_menu_select_upgrade', {})
      upgradeCall(onDone, context).then((jsx) => {
        if (jsx) {
          setSubCommandJSX(jsx)
        }
      })
    } else if (value === 'cancel') {
      handleCancel()
    }
  }
  if (subCommandJSX) {
    return subCommandJSX
  }
  return (
    <Dialog title={tSync('rateLimit.whatDoYouWant')} onCancel={handleCancel} color="suggestion">
      {<Select options={options} onChange={handleSelect} visibleOptionCount={options.length} />}
    </Dialog>
  )
}
export async function call(
  onDone: LocalJSXCommandOnDone,
  context: ToolUseContext & LocalJSXCommandContext,
): Promise<React.ReactNode> {
  return <RateLimitOptionsMenu onDone={onDone} context={context} />
}
