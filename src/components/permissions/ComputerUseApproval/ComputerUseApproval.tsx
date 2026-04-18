import { getSentinelCategory } from '@ant/computer-use-mcp/sentinelApps';
import type { CuPermissionRequest, CuPermissionResponse } from '@ant/computer-use-mcp/types';
import { DEFAULT_GRANT_FLAGS } from '@ant/computer-use-mcp/types';
import figures from 'figures';
import * as React from 'react';
import { useState } from 'react';
import { Box, Text } from '../../../ink.js';
import { execFileNoThrow } from '../../../utils/execFileNoThrow.js';
import { plural } from '../../../utils/stringUtils.js';
import { Select } from '../../CustomSelect/select.js';
import { Dialog } from '../../design-system/Dialog.js';
type ComputerUseApprovalProps = {
  request: CuPermissionRequest;
  onDone: (response: CuPermissionResponse) => void;
};
const DENY_ALL_RESPONSE: CuPermissionResponse = {
  granted: [],
  denied: [],
  flags: DEFAULT_GRANT_FLAGS
};

/**
 * Two-panel dispatcher. When `request.tccState` is present, macOS permissions
 * (Accessibility / Screen Recording) are missing and the app list is
 * irrelevant — show a TCC panel that opens System Settings. Otherwise show the
 * app allowlist + grant-flags panel.
 */
export function ComputerUseApproval({
  request,
  onDone
}: ComputerUseApprovalProps) {
  return (request as any).tccState ? <ComputerUseTccPanel tccState={(request as any).tccState} onDone={() => onDone(DENY_ALL_RESPONSE)} /> : <ComputerUseAppListPanel request={request} onDone={onDone} />;
}

// ── TCC panel ─────────────────────────────────────────────────────────────

type TccOption = 'open_accessibility' | 'open_screen_recording' | 'retry';
function ComputerUseTccPanel({
  tccState,
  onDone
}) {
  const opts = [];
  if (!tccState.accessibility) {
    opts.push({
      label: "Open System Settings \u2192 Accessibility",
      value: "open_accessibility"
    });
  }
  if (!tccState.screenRecording) {
    opts.push({
      label: "Open System Settings \u2192 Screen Recording",
      value: "open_screen_recording"
    });
  }
  opts.push({
    label: "Try again",
    value: "retry"
  });
  const options = opts;
  const onChange = function onChange(value) {
    switch (value) {
      case "open_accessibility":
        {
          execFileNoThrow("open", ["x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"], {
            useCwd: false
          });
          return;
        }
      case "open_screen_recording":
        {
          execFileNoThrow("open", ["x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"], {
            useCwd: false
          });
          return;
        }
      case "retry":
        {
          onDone();
          return;
        }
    }
  };
  return <Dialog title="Computer Use needs macOS permissions" onCancel={onDone}>{<Box flexDirection="column" paddingX={1} paddingY={1} gap={1}>{<Box flexDirection="column">{<Text>Accessibility:{" "}{tccState.accessibility ? `${figures.tick} granted` : `${figures.cross} not granted`}</Text>}{<Text>Screen Recording:{" "}{tccState.screenRecording ? `${figures.tick} granted` : `${figures.cross} not granted`}</Text>}</Box>}{<Text dimColor={true}>Grant the missing permissions in System Settings, then select "Try again". macOS may require you to restart ZY Code after granting Screen Recording.</Text>}{<Select options={options} onChange={onChange} onCancel={onDone} />}</Box>}</Dialog>;
}

// ── App allowlist panel ───────────────────────────────────────────────────

type AppListOption = 'allow_all' | 'deny';
const SENTINEL_WARNING: Record<NonNullable<ReturnType<typeof getSentinelCategory>>, string> = {
  shell: 'equivalent to shell access',
  filesystem: 'can read/write any file',
  system_settings: 'can change system settings'
};
function ComputerUseAppListPanel({
  request,
  onDone
}) {
  const [checked] = useState(() => new Set(request.apps.flatMap(a => a.resolved && !a.alreadyGranted ? [a.resolved.bundleId] : [])));
  const ALL_FLAG_KEYS = ["clipboardRead", "clipboardWrite", "systemKeyCombos"];
  const requestedFlagKeys = ALL_FLAG_KEYS.filter(k => request.requestedFlags[k]);
  const t5 = plural(checked.size, "app");
  const options = [{
    label: `Allow for this session (${checked.size} ${t5})`,
    value: "allow_all"
  }, {
    label: <Text>Deny, and tell Zy what to do differently <Text bold={true}>(esc)</Text></Text>,
    value: "deny"
  }];
  const respond = function respond(allow) {
    if (!allow) {
      onDone(DENY_ALL_RESPONSE);
      return;
    }
    const now = Date.now();
    const granted = request.apps.flatMap(a_0 => a_0.resolved && checked.has(a_0.resolved.bundleId) ? [{
      bundleId: a_0.resolved.bundleId,
      displayName: a_0.resolved.displayName,
      grantedAt: now
    }] : []);
    const denied = request.apps.filter(a_1 => !a_1.resolved || !checked.has(a_1.resolved.bundleId)).map(a_2 => ({
      bundleId: a_2.resolved?.bundleId ?? a_2.requestedName,
      reason: a_2.resolved ? "user_denied" as const : "not_installed" as const
    }));
    const flags = {
      ...DEFAULT_GRANT_FLAGS,
      ...Object.fromEntries(requestedFlagKeys.map(k_0 => [k_0, true] as const))
    };
    onDone({
      granted,
      denied,
      flags
    });
  };
  const t13 = request.apps.map(a_3 => {
    const resolved = a_3.resolved;
    if (!resolved) {
      return <Text key={a_3.requestedName} dimColor={true}>{"  "}{figures.circle} {a_3.requestedName}{" "}<Text dimColor={true}>(not installed)</Text></Text>;
    }
    if (a_3.alreadyGranted) {
      return <Text key={resolved.bundleId} dimColor={true}>{"  "}{figures.tick} {resolved.displayName}{" "}<Text dimColor={true}>(already granted)</Text></Text>;
    }
    const sentinel = getSentinelCategory(resolved.bundleId);
    const isChecked = checked.has(resolved.bundleId);
    return <Box key={resolved.bundleId} flexDirection="column"><Text>{"  "}{isChecked ? figures.circleFilled : figures.circle}{" "}{resolved.displayName}</Text>{sentinel ? <Text bold={true}>{"    "}{figures.warning} {SENTINEL_WARNING[sentinel]}</Text> : null}</Box>;
  });
  return <Dialog title="Computer Use wants to control these apps" onCancel={() => respond(false)}>{<Box flexDirection="column" paddingX={1} paddingY={1} gap={1}>{request.reason ? <Text dimColor={true}>{request.reason}</Text> : null}{<Box flexDirection="column">{t13}</Box>}{requestedFlagKeys.length > 0 ? <Box flexDirection="column"><Text dimColor={true}>Also requested:</Text>{requestedFlagKeys.map(flag => <Text key={flag} dimColor={true}>{"  "}· {flag}</Text>)}</Box> : null}{request.willHide && request.willHide.length > 0 ? <Text dimColor={true}>{request.willHide.length} other{" "}{plural(request.willHide.length, "app")} will be hidden while Zy works.</Text> : null}{<Select options={options} onChange={v => respond(v === "allow_all")} onCancel={() => respond(false)} />}</Box>}</Dialog>;
}
