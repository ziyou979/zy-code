import { Box, Text } from '../../ink/index.js'
import { getAgentModelOptions } from '../../services/model/agent.js'
import { Select } from '../CustomSelect/select.js'

interface ModelSelectorProps {
  initialModel?: string
  onComplete: (model?: string) => void
  onCancel?: () => void
}
export function ModelSelector({ initialModel, onComplete, onCancel }: ModelSelectorProps) {
  let modelOptions
  const base = getAgentModelOptions()
  if (initialModel && !base.some((o) => o.value === initialModel)) {
    modelOptions = [
      {
        value: initialModel,
        label: initialModel,
        description: 'Current model (custom ID)',
      },
      ...base,
    ]
  } else {
    modelOptions = base
  }
  const defaultModel = initialModel ?? 'standard'
  return (
    <Box flexDirection="column">
      {
        <Box marginBottom={1}>
          <Text dimColor={true}>
            Model determines the agent's reasoning capabilities and speed.
          </Text>
        </Box>
      }
      <Select
        options={modelOptions}
        defaultValue={defaultModel}
        onChange={onComplete}
        onCancel={() => (onCancel ? onCancel() : onComplete(undefined))}
      />
    </Box>
  )
}
