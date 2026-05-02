import * as React from 'react'
import { useEffect, useState } from 'react'
import {
  getAllOutputStyles,
  OUTPUT_STYLE_CONFIG,
  type OutputStyleConfig,
} from '../constants/outputStyles.js'
import { Box, Text } from '../ink.js'
import type { OutputStyle } from '../utils/config.js'
import { getCwd } from '../utils/cwd.js'
import type { OptionWithDescription } from './CustomSelect/select.js'
import { Select } from './CustomSelect/select.js'
import { Dialog } from './design-system/Dialog.js'
import { tSync } from 'src/i18n/index.js'
const DEFAULT_OUTPUT_STYLE_LABEL = 'Default'
const DEFAULT_OUTPUT_STYLE_DESCRIPTION =
  'Zy completes coding tasks efficiently and provides concise responses'
function mapConfigsToOptions(styles: {
  [styleName: string]: OutputStyleConfig | null
}): OptionWithDescription[] {
  return Object.entries(styles).map(([style, config]) => ({
    label: config?.name ?? DEFAULT_OUTPUT_STYLE_LABEL,
    value: style,
    description: config?.description ?? DEFAULT_OUTPUT_STYLE_DESCRIPTION,
  }))
}
export type OutputStylePickerProps = {
  initialStyle: OutputStyle
  onComplete: (style: OutputStyle) => void
  onCancel: () => void
  isStandaloneCommand?: boolean
}
export function OutputStylePicker({
  initialStyle,
  onComplete,
  onCancel,
  isStandaloneCommand,
}: OutputStylePickerProps) {
  const [styleOptions, setStyleOptions] = useState([])
  const [isLoading, setIsLoading] = useState(true)
  useEffect(() => {
    getAllOutputStyles(getCwd())
      .then((allStyles) => {
        const options = mapConfigsToOptions(allStyles)
        setStyleOptions(options)
        setIsLoading(false)
      })
      .catch(() => {
        const builtInOptions = mapConfigsToOptions(OUTPUT_STYLE_CONFIG)
        setStyleOptions(builtInOptions)
        setIsLoading(false)
      })
  }, [])
  const handleStyleSelect = (style) => {
    const outputStyle = style as OutputStyle
    onComplete(outputStyle)
  }
  return (
    <Dialog
      title={tSync('outputStyle.title')}
      onCancel={onCancel}
      hideInputGuide={!isStandaloneCommand}
      hideBorder={!isStandaloneCommand}
    >
      {
        <Box flexDirection="column" gap={1}>
          {
            <Box marginTop={1}>
              <Text dimColor={true}>{tSync('outputStyle.hint')}</Text>
            </Box>
          }
          {isLoading ? (
            <Text dimColor={true}>{tSync('outputStyle.loading')}</Text>
          ) : (
            <Select
              options={styleOptions}
              onChange={handleStyleSelect}
              visibleOptionCount={10}
              defaultValue={initialStyle}
            />
          )}
        </Box>
      }
    </Dialog>
  )
}
