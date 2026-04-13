import * as React from 'react';
import { useEffect, useState } from 'react';
// eslint-disable-next-line custom-rules/prefer-use-keybindings -- 'r' is a view-specific key, not a global keybinding
import { Box, Text, useInput } from '../../../ink.js';
import { type AutoModeDenial, getAutoModeDenials } from '../../../utils/autoModeDenials.js';
import { Select } from '../../CustomSelect/select.js';
import { StatusIcon } from '../../design-system/StatusIcon.js';
import { useTabHeaderFocus } from '../../design-system/Tabs.js';
type Props = {
  onHeaderFocusChange?: (focused: boolean) => void;
  /** Called when approved/retry state changes so parent can act on exit */
  onStateChange: (state: {
    approved: Set<number>;
    retry: Set<number>;
    denials: readonly AutoModeDenial[];
  }) => void;
};
export function RecentDenialsTab({
  onHeaderFocusChange,
  onStateChange
}: Props) {
  const {
    headerFocused,
    focusHeader
  } = useTabHeaderFocus();
  useEffect(() => {
    onHeaderFocusChange?.(headerFocused);
  }, [headerFocused, onHeaderFocusChange]);
  const [denials] = useState(() => getAutoModeDenials());
  const [approved, setApproved] = useState(() => new Set());
  const [retry, setRetry] = useState(() => new Set());
  const [focusedIdx, setFocusedIdx] = useState(0);
  useEffect(() => {
    onStateChange({
      approved,
      retry,
      denials
    });
  }, [approved, retry, denials, onStateChange]);
  const handleSelect = value => {
    const idx = Number(value);
    setApproved(prev => {
      const next = new Set(prev);
      if (next.has(idx)) {
        next.delete(idx);
      } else {
        next.add(idx);
      }
      return next;
    });
  };
  const handleFocus = value_0 => {
    setFocusedIdx(Number(value_0));
  };
  useInput((input, _key) => {
    if (input === "r") {
      setRetry(prev_0 => {
        const next_0 = new Set(prev_0);
        if (next_0.has(focusedIdx)) {
          next_0.delete(focusedIdx);
        } else {
          next_0.add(focusedIdx);
        }
        return next_0;
      });
      setApproved(prev_1 => {
        if (prev_1.has(focusedIdx)) {
          return prev_1;
        }
        const next_1 = new Set(prev_1);
        next_1.add(focusedIdx);
        return next_1;
      });
    }
  }, {
    isActive: denials.length > 0
  });
  if (denials.length === 0) {
    return <Text dimColor={true}>No recent denials. Commands denied by the auto mode classifier will appear here.</Text>;
  }
  const options = denials.map((d, idx_0) => {
    const isApproved = approved.has(idx_0);
    const suffix = retry.has(idx_0) ? " (retry)" : "";
    return {
      label: <Text><StatusIcon status={isApproved ? "success" : "error"} withSpace={true} />{d.display}<Text dimColor={true}>{suffix}</Text></Text>,
      value: String(idx_0)
    };
  });
  const t12 = Math.min(10, options.length);
  return <Box flexDirection="column">{<Text>Commands recently denied by the auto mode classifier.</Text>}<Box marginTop={1}><Select options={options} onChange={handleSelect} onFocus={handleFocus} visibleOptionCount={t12} isDisabled={headerFocused} onUpFromFirstItem={focusHeader} /></Box></Box>;
}
