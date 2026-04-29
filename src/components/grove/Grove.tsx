import React, { useEffect, useState } from 'react';
import { type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS, logEvent } from 'src/services/analytics/index.js';
import { tSync } from 'src/i18n/index.js';
import { Box, Link, Text, useInput } from '../../ink.js';
import { type AccountSettings, calculateShouldShowGrove, getGroveNoticeConfig, getGroveSettings, markGroveNoticeViewed, updateGroveSettings } from '../../services/api/grove.js';
import { Select } from '../CustomSelect/index.js';
import { Byline } from '../design-system/Byline.js';
import { Dialog } from '../design-system/Dialog.js';
import { KeyboardShortcutHint } from '../design-system/KeyboardShortcutHint.js';
export type GroveDecision = 'accept_opt_in' | 'accept_opt_out' | 'defer' | 'escape' | 'skip_rendering';
type Props = {
  showIfAlreadyViewed: boolean;
  location: 'settings' | 'policy_update_modal' | 'onboarding';
  onDone(decision: GroveDecision): void;
};
const NEW_TERMS_ASCII = ` _____________
 |          \\  \\
 | NEW TERMS \\__\\
 |              |
 |  ----------  |
 |  ----------  |
 |  ----------  |
 |  ----------  |
 |  ----------  |
 |              |
 |______________|`;
function GracePeriodContentBody() {
  return <>{<Text>{tSync('grove.termsUpdateNotice', { date: 'October 8, 2025' })}</Text>}{<Box flexDirection="column">{<Text>{tSync('grove.whatsChanging')}</Text>}{<Box paddingLeft={1}><Text>{<Text>· </Text>}{<Text bold={true}>{tSync('grove.helpImproveZy')} </Text>}<Text>{tSync('grove.helpImproveDesc')} (<Link url="https://zy.ai/settings/data-privacy-controls" />).</Text></Text></Box>}<Box paddingLeft={1}><Text><Text>· </Text><Text bold={true}>{tSync('grove.dataRetentionUpdate')} </Text><Text>{tSync('grove.dataRetentionDesc')}</Text></Text></Box></Box>}<Text>{tSync('grove.learnMore')} ({<Link url="https://www.anthropic.com/news/updates-to-our-consumer-terms" />}) {tSync('grove.orReadTerms')} ({<Link url="https://anthropic.com/legal/terms" />}) {tSync('grove.andPrivacyPolicy')} (<Link url="https://anthropic.com/legal/privacy" />)</Text></>;
}
function PostGracePeriodContentBody() {
  return <>{<Text>{tSync('grove.termsUpdated')}</Text>}{<Box flexDirection="column" gap={1}>{<Text>{tSync('grove.whatsChanging')}</Text>}{<Box flexDirection="column"><Text bold={true}>{tSync('grove.helpImproveZy')}</Text><Text>{tSync('grove.helpImprovePostDesc')}</Text><Link url="https://zy.ai/settings/data-privacy-controls" /></Box>}<Box flexDirection="column"><Text bold={true}>{tSync('grove.howAffectsRetention')}</Text><Text>{tSync('grove.howAffectsRetentionDesc')}</Text></Box></Box>}<Text>{tSync('grove.learnMore')} ({<Link url="https://www.anthropic.com/news/updates-to-our-consumer-terms" />}) {tSync('grove.orReadTerms')} ({<Link url="https://anthropic.com/legal/terms" />}) {tSync('grove.andPrivacyPolicy')} (<Link url="https://anthropic.com/legal/privacy" />)</Text></>;
}
export function GroveDialog({
  showIfAlreadyViewed,
  location,
  onDone
}) {
  const [shouldShowDialog, setShouldShowDialog] = useState(null);
  const [groveConfig, setGroveConfig] = useState(null);
  useEffect(() => {
    const checkGroveSettings = async function checkGroveSettings() {
      const [settingsResult, configResult] = await Promise.all([getGroveSettings(), getGroveNoticeConfig()]);
      const config = configResult.success ? configResult.data : null;
      setGroveConfig(config);
      const shouldShow = calculateShouldShowGrove(settingsResult, configResult, showIfAlreadyViewed);
      setShouldShowDialog(shouldShow);
      if (!shouldShow) {
        onDone("skip_rendering");
        return;
      }
      markGroveNoticeViewed();
      logEvent("zy_grove_policy_viewed", {
        location: location as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
        dismissable: config?.notice_is_grace_period as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
      });
    };
    checkGroveSettings();
  }, [showIfAlreadyViewed, location, onDone]);
  if (shouldShowDialog === null) {
    return null;
  }
  if (!shouldShowDialog) {
    return null;
  }
  const onChange = async function onChange(value) {
    switch (value) {
      case "accept_opt_in":
        {
          await updateGroveSettings(true);
          logEvent("zy_grove_policy_submitted", {
            state: true,
            dismissable: groveConfig?.notice_is_grace_period as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
          });
          break;
        }
      case "accept_opt_out":
        {
          await updateGroveSettings(false);
          logEvent("zy_grove_policy_submitted", {
            state: false,
            dismissable: groveConfig?.notice_is_grace_period as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
          });
          break;
        }
      case "defer":
        {
          logEvent("zy_grove_policy_dismissed", {
            state: true
          });
          break;
        }
      case "escape":
        {
          logEvent("zy_grove_policy_escaped", {});
        }
    }
    onDone(value);
  };
  const acceptOptions = groveConfig?.domain_excluded ? [{
    label: tSync('grove.acceptTermsOptOutDomain'),
    value: "accept_opt_out"
  }] : [{
    label: tSync('grove.acceptTermsOptIn'),
    value: "accept_opt_in"
  }, {
    label: tSync('grove.acceptTermsOptOut'),
    value: "accept_opt_out"
  }];
  const handleCancel = function handleCancel() {
    if (groveConfig?.notice_is_grace_period) {
      onChange("defer");
      return;
    }
    onChange("escape");
  };
  const t10 = groveConfig?.notice_is_grace_period ? [{
    label: tSync('grove.notNow'),
    value: "defer"
  }] : [];
  return <Dialog title={tSync('grove.dialogTitle')} color="professionalBlue" onCancel={handleCancel} inputGuide={exitState => exitState.pending ? <Text>{tSync('grove.pressAgainToExit', { keyName: exitState.keyName })}</Text> : <Byline><KeyboardShortcutHint shortcut="Enter" action="confirm" /><KeyboardShortcutHint shortcut="Esc" action="cancel" /></Byline>}>{<Box flexDirection="row">{<Box flexDirection="column" gap={1} flexGrow={1}>{groveConfig?.notice_is_grace_period ? <GracePeriodContentBody /> : <PostGracePeriodContentBody />}</Box>}{<Box flexShrink={0}><Text color="professionalBlue">{NEW_TERMS_ASCII}</Text></Box>}</Box>}{<Box flexDirection="column" gap={1}>{<Box flexDirection="column"><Text bold={true}>{tSync('grove.selectHowToContinue')}</Text><Text>{tSync('grove.choiceTakesEffect')}</Text></Box>}<Select options={[...acceptOptions, ...t10]} onChange={value_0 => onChange(value_0 as 'accept_opt_in' | 'accept_opt_out' | 'defer')} onCancel={handleCancel} /></Box>}</Dialog>;
}
type PrivacySettingsDialogProps = {
  settings: AccountSettings;
  domainExcluded?: boolean;
  onDone(): void;
};
export function PrivacySettingsDialog({
  settings,
  domainExcluded,
  onDone
}: PrivacySettingsDialogProps) {
  const [groveEnabled, setGroveEnabled] = useState(settings.grove_enabled);
  React.useEffect(() => {
    logEvent("zy_grove_privacy_settings_viewed", {});
  }, []);
  useInput(async (input, key) => {
    if (!domainExcluded && (key.tab || key.return || input === " ")) {
      const newValue = !groveEnabled;
      setGroveEnabled(newValue);
      await updateGroveSettings(newValue);
    }
  });
  let valueComponent = <Text color="error">false</Text>;
  if (domainExcluded) {
    valueComponent = <Text color="error">false (for emails with your domain)</Text>;
  } else {
    if (groveEnabled) {
      valueComponent = <Text color="success">true</Text>;
    }
  }
  return <Dialog title={tSync('grove.dataPrivacyTitle')} color="professionalBlue" onCancel={onDone} inputGuide={exitState => exitState.pending ? <Text>{tSync('grove.pressAgainToExit', { keyName: exitState.keyName })}</Text> : domainExcluded ? <KeyboardShortcutHint shortcut="Esc" action="cancel" /> : <Byline><KeyboardShortcutHint shortcut="Enter/Tab/Space" action="toggle" /><KeyboardShortcutHint shortcut="Esc" action="cancel" /></Byline>}>{<Text>{tSync('grove.reviewPrivacySettings')}{" "}<Link url="https://zy.ai/settings/data-privacy-controls" /></Text>}{<Box>{<Box width={44}><Text bold={true}>{tSync('grove.helpImproveZy')}</Text></Box>}<Box>{valueComponent}</Box></Box>}</Dialog>;
}
