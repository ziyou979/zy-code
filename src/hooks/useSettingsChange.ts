import { useCallback, useEffect } from 'react'
import { settingsChangeDetector } from '../services/settings/changeDetector.js'
import type { SettingSource } from '../services/settings/constants.js'
import { getInitialSettings } from '../services/settings/settings.js'
import type { SettingsJson } from '../services/settings/types.js'

export function useSettingsChange(
  onChange: (source: SettingSource, settings: SettingsJson) => void,
): void {
  const handleChange = useCallback(
    (source: SettingSource) => {
      // notifier（changeDetector.fanOut）已重置 cache。若在此再次重置，
      // N 个订阅者会造成 N 路抖动：每个订阅者都清除 cache、重新读盘，
      // 然后下一个订阅者再次清除。
      const newSettings = getInitialSettings()
      onChange(source, newSettings)
    },
    [onChange],
  )

  useEffect(() => settingsChangeDetector.subscribe(handleChange), [handleChange])
}
