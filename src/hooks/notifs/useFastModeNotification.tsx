import { c as _c } from "react/compiler-runtime";
import { useEffect } from 'react';
import { useNotifications } from 'src/context/notifications.js';
import { useAppState, useSetAppState } from 'src/state/AppState.js';
import { type CooldownReason, isFastModeEnabled, onCooldownExpired, onCooldownTriggered, onFastModeOverageRejection } from 'src/utils/fastMode.js';
import { formatDuration } from 'src/utils/format.js';
import { getIsRemoteMode } from '../../bootstrap/state.js';
const COOLDOWN_STARTED_KEY = 'fast-mode-cooldown-started';
const COOLDOWN_EXPIRED_KEY = 'fast-mode-cooldown-expired';
const OVERAGE_REJECTED_KEY = 'fast-mode-overage-rejected';
export function useFastModeNotification() {
  const $ = _c(10);
  const {
    addNotification
  } = useNotifications();
  const isFastMode = useAppState(_temp);
  const setAppState = useSetAppState();
  let t0;
  let t1;
  if ($[0] !== addNotification || $[1] !== setAppState) {
    t0 = () => {
      if (getIsRemoteMode()) {
        return;
      }
      if (!isFastModeEnabled()) {
        return;
      }
      return onFastModeOverageRejection(message => {
        setAppState(_temp2);
        addNotification({
          key: OVERAGE_REJECTED_KEY,
          color: "warning",
          priority: "immediate",
          text: message
        });
      });
    };
    t1 = [addNotification, setAppState];
    $[0] = addNotification;
    $[1] = setAppState;
    $[2] = t0;
    $[3] = t1;
  } else {
    t0 = $[2];
    t1 = $[3];
  }
  useEffect(t0, t1);
  let t2;
  let t3;
  if ($[4] !== addNotification || $[5] !== isFastMode) {
    t2 = () => {
      if (getIsRemoteMode()) {
        return;
      }
      if (!isFastMode) {
        return;
      }
      const unsubTriggered = onCooldownTriggered((resetAt, reason) => {
        const resetIn = formatDuration(resetAt - Date.now(), {
          hideTrailingZeros: true
        });
        const message_0 = getCooldownMessage(reason, resetIn);
        addNotification({
          key: COOLDOWN_STARTED_KEY,
          invalidates: [COOLDOWN_EXPIRED_KEY],
          text: message_0,
          color: "warning",
          priority: "immediate"
        });
      });
      const unsubExpired = onCooldownExpired(() => {
        addNotification({
          key: COOLDOWN_EXPIRED_KEY,
          invalidates: [COOLDOWN_STARTED_KEY],
          color: "fastMode",
          text: "Fast limit reset \xB7 now using fast mode",
          priority: "immediate"
        });
      });
      return () => {
        unsubTriggered();
        unsubExpired();
      };
    };
    t3 = [addNotification, isFastMode];
    $[4] = addNotification;
    $[5] = isFastMode;
    $[6] = t2;
    $[7] = t3;
  } else {
    t2 = $[6];
    t3 = $[7];
  }
  useEffect(t2, t3);
}
function _temp2(prev_0) {
  return {
    ...prev_0,
    fastMode: false
  };
}
function _temp(s) {
  return s.fastMode;
}
function getCooldownMessage(reason: CooldownReason, resetIn: string): string {
  switch (reason) {
    case 'overloaded':
      return `Fast mode overloaded and is temporarily unavailable · resets in ${resetIn}`;
    case 'rate_limit':
      return `Fast limit reached and temporarily disabled · resets in ${resetIn}`;
  }
}
