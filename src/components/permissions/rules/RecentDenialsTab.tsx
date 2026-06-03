import { useEffect, useState } from 'react'
import { tSync } from 'src/i18n/index.js'
// eslint-disable-next-line custom-rules/prefer-use-keybindings -- 'r' is a view-specific key, not a global keybinding
import { Box, Text, useInput } from '../../../ink.js'
import { type AutoModeDenial, getAutoModeDenials } from '../../../utils/autoModeDenials.js'
import { Select } from '../../CustomSelect/select.js'
import { StatusIcon } from '../../design-system/StatusIcon.js'
import { useTabHeaderFocus } from '../../design-system/Tabs.js'

type Props = {
  onHeaderFocusChange?: (focused: boolean) => void
  /** Called when approved/retry state changes so parent can act on exit */
  onStateChange: (state: {
    approved: Set<number>
    retry: Set<number>
    denials: readonly AutoModeDenial[]
  }) => void
}
export function RecentDenialsTab({ onHeaderFocusChange, onStateChange }: Props) {
  const { headerFocused, focusHeader } = useTabHeaderFocus()
  useEffect(() => {
    onHeaderFocusChange?.(headerFocused)
  }, [headerFocused, onHeaderFocusChange])
  const [denials] = useState(() => getAutoModeDenials())
  const [approved, setApproved] = useState(() => new Set<number>())
  const [retry, setRetry] = useState(() => new Set<number>())
  const [focusedIdx, setFocusedIdx] = useState(0)
  useEffect(() => {
    onStateChange({
      approved,
      retry,
      denials,
    })
  }, [approved, retry, denials, onStateChange])
  const handleSelect = (value: string) => {
    const idx = Number(value)
    setApproved((prev) => {
      const next = new Set(prev)
      if (next.has(idx)) {
        next.delete(idx)
      } else {
        next.add(idx)
      }
      return next
    })
  }
  const handleFocus = (focusedValue: string) => {
    setFocusedIdx(Number(focusedValue))
  }
  useInput(
    (input, _key) => {
      if (input === 'r') {
        setRetry((prevRetrySet) => {
          const nextRetrySet = new Set(prevRetrySet)
          if (nextRetrySet.has(focusedIdx)) {
            nextRetrySet.delete(focusedIdx)
          } else {
            nextRetrySet.add(focusedIdx)
          }
          return nextRetrySet
        })
        setApproved((prevApprovedSet) => {
          if (prevApprovedSet.has(focusedIdx)) {
            return prevApprovedSet
          }
          const nextApprovedSet = new Set(prevApprovedSet)
          nextApprovedSet.add(focusedIdx)
          return nextApprovedSet
        })
      }
    },
    {
      isActive: denials.length > 0,
    },
  )
  if (denials.length === 0) {
    return <Text dimColor={true}>{tSync('permissionRules.noRecentDenials')}</Text>
  }
  const options = denials.map((d, denialIndex) => {
    const isApproved = approved.has(denialIndex)
    const suffix = retry.has(denialIndex) ? tSync('permissionRules.retrySuffix') : ''
    return {
      label: (
        <Text>
          <StatusIcon status={isApproved ? 'success' : 'error'} withSpace={true} />
          {d.display}
          <Text dimColor={true}>{suffix}</Text>
        </Text>
      ),
      value: String(denialIndex),
    }
  })
  const visibleOptionCount = Math.min(10, options.length)
  return (
    <Box flexDirection="column">
      {<Text>{tSync('permissionRules.recentlyDeniedDescription')}</Text>}
      <Box marginTop={1}>
        <Select
          options={options}
          onChange={handleSelect}
          onFocus={handleFocus}
          visibleOptionCount={visibleOptionCount}
          isDisabled={headerFocused}
          onUpFromFirstItem={focusHeader}
        />
      </Box>
    </Box>
  )
}
