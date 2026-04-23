import * as React from 'react';
import { useCallback, useEffect, useState } from 'react';
import type { CommandResultDisplay } from '../../commands.js';
import { TEARDROP_ASTERISK } from '../../constants/figures.js';
import { useExitOnCtrlCDWithKeybindings } from '../../hooks/useExitOnCtrlCDWithKeybindings.js';
import { setClipboard } from '../../ink/termio/osc.js';
// eslint-disable-next-line custom-rules/prefer-use-keybindings -- enter to copy link
import { Box, Link, Text, useInput } from '../../ink.js';
import { useKeybinding } from '../../keybindings/useKeybinding.js';
import { logEvent } from '../../services/analytics/index.js';
import { fetchReferralRedemptions, formatCreditAmount, getCachedOrFetchPassesEligibility } from '../../services/api/referral.js';
// @ts-ignore
import type { ReferralRedemptionsResponse, ReferrerRewardInfo } from '../../services/oauth/types.js';
import { count } from '../../utils/array.js';
import { logError } from '../../utils/log.js';
import { Pane } from '../design-system/Pane.js';
type PassStatus = {
  passNumber: number;
  isAvailable: boolean;
};
type Props = {
  onDone: (result?: string, options?: {
    display?: CommandResultDisplay;
  }) => void;
};
export function Passes({
  onDone
}: Props): React.ReactNode {
  const [loading, setLoading] = useState(true);
  const [passStatuses, setPassStatuses] = useState<PassStatus[]>([]);
  const [isAvailable, setIsAvailable] = useState(false);
  const [referralLink, setReferralLink] = useState<string | null>(null);
  const [referrerReward, setReferrerReward] = useState<ReferrerRewardInfo | null | undefined>(undefined);
  const exitState = useExitOnCtrlCDWithKeybindings(() => onDone('Guest passes dialog dismissed', {
    display: 'system'
  }));
  const handleCancel = useCallback(() => {
    onDone('Guest passes dialog dismissed', {
      display: 'system'
    });
  }, [onDone]);
  useKeybinding('confirm:no', handleCancel, {
    context: 'Confirmation'
  });
  useInput((_input, key) => {
    if (key.return && referralLink) {
      void setClipboard(referralLink).then(raw => {
        if (raw) process.stdout.write(raw);
        logEvent('zy_guest_passes_link_copied', {});
        onDone(`Referral link copied to clipboard!`);
      });
    }
  });
  useEffect(() => {
    async function loadPassesData() {
      try {
        // 首先检查资格（如果可用则使用缓存）
        const eligibilityData = await getCachedOrFetchPassesEligibility();
        if (!eligibilityData || !eligibilityData.eligible) {
          setIsAvailable(false);
          setLoading(false);
          return;
        }
        setIsAvailable(true);

        // 存储推荐链接（如果可用）
        if (eligibilityData.referral_code_details?.referral_link) {
          setReferralLink(eligibilityData.referral_code_details.referral_link);
        }

        // 存储推荐人奖励信息用于 v1 活动消息
        setReferrerReward(eligibilityData.referrer_reward);

        // 使用资格返回的活动进行兑换
        const campaign = eligibilityData.referral_code_details?.campaign ?? 'zy_code_guest_pass';

        // 获取兑换数据
        let redemptionsData: ReferralRedemptionsResponse;
        try {
          redemptionsData = await fetchReferralRedemptions(campaign);
        } catch (err_0) {
          logError(err_0 as Error);
          setIsAvailable(false);
          setLoading(false);
          return;
        }

        // 构建通行证状态数组
        const redemptions = redemptionsData.redemptions || [];
        const maxRedemptions = redemptionsData.limit || 3;
        const statuses: PassStatus[] = [];
        for (let i = 0; i < maxRedemptions; i++) {
          const redemption = redemptions[i];
          statuses.push({
            passNumber: i + 1,
            isAvailable: !redemption
          });
        }
        setPassStatuses(statuses);
        setLoading(false);
      } catch (err) {
        // 对于任何错误，都显示通行证不可用
        logError(err as Error);
        setIsAvailable(false);
        setLoading(false);
      }
    }
    void loadPassesData();
  }, []);
  if (loading) {
    return <Pane>
        <Box flexDirection="column" gap={1}>
          <Text dimColor>Loading guest pass information…</Text>
          <Text dimColor italic>
            {exitState.pending ? <>Press {exitState.keyName} again to exit</> : <>Esc to cancel</>}
          </Text>
        </Box>
      </Pane>;
  }
  if (!isAvailable) {
    return <Pane>
        <Box flexDirection="column" gap={1}>
          <Text>Guest passes are not currently available.</Text>
          <Text dimColor italic>
            {exitState.pending ? <>Press {exitState.keyName} again to exit</> : <>Esc to cancel</>}
          </Text>
        </Box>
      </Pane>;
  }
  const availableCount = count(passStatuses, p => p.isAvailable);

  // 排序通行证：可用的在前，然后已兑换的
  const sortedPasses = [...passStatuses].sort((a, b) => +b.isAvailable - +a.isAvailable);

  // 票证的 ASCII 艺术
  const renderTicket = (pass: PassStatus) => {
    const isRedeemed = !pass.isAvailable;
    if (isRedeemed) {
      // 灰显已兑换的票证，带斜线
      return <Box key={pass.passNumber} flexDirection="column" marginRight={1}>
          <Text dimColor>{'┌─────────╱'}</Text>
          <Text dimColor>{` ) CC ${TEARDROP_ASTERISK} ┊╱`}</Text>
          <Text dimColor>{'└───────╱'}</Text>
        </Box>;
    }
    return <Box key={pass.passNumber} flexDirection="column" marginRight={1}>
        <Text>{'┌──────────┐'}</Text>
        <Text>
          {' ) CC '}
          <Text color="zy">{TEARDROP_ASTERISK}</Text>
          {' ┊ ( '}
        </Text>
        <Text>{'└──────────┘'}</Text>
      </Box>;
  };
  return <Pane>
      <Box flexDirection="column" gap={1}>
        <Text color="permission">Guest passes · {availableCount} left</Text>

        <Box flexDirection="row" marginLeft={2}>
          {sortedPasses.slice(0, 3).map(pass_0 => renderTicket(pass_0))}
        </Box>

        {referralLink && <Box marginLeft={2}>
            <Text>{referralLink}</Text>
          </Box>}

        <Box flexDirection="column" marginLeft={2}>
          <Text dimColor>
            {referrerReward ? `Share a free week of ZY Code with friends. If they love it and subscribe, you'll get ${formatCreditAmount(referrerReward)} of extra usage to keep building. ` : 'Share a free week of ZY Code with friends. '}
            <Link url={referrerReward ? 'https://support.zy.com/en/articles/13456702-zy-code-guest-passes' : 'https://support.zy.com/en/articles/12875061-zy-code-guest-passes'}>
              Terms apply.
            </Link>
          </Text>
        </Box>

        <Box>
          <Text dimColor italic>
            {exitState.pending ? <>Press {exitState.keyName} again to exit</> : <>Enter to copy link · Esc to cancel</>}
          </Text>
        </Box>
      </Box>
    </Pane>;
}
