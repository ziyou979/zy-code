import { useEffect, useState } from 'react'
import { tSync } from '../i18n/index.js'
import { Box, Text } from '../ink/index.js'
import {
  getModelThinkingSupport,
  mergeModelCatalogCapabilities,
  removeThinkingEffortOverride,
  type ModelCatalogCapability,
} from '../services/model/modelCatalogCapabilities.js'
import { Select } from './CustomSelect/select.js'
import { parseEffortMapping } from '../services/effort/effortMapping.js'

import { isImageInput, isModelInputModality } from '../services/model/modelInputTypes.js'

type Field = 'input' | 'image' | 'thinking' | 'structured' | 'context' | 'output' | 'effort'

/** 每个连接可直接编辑能力覆盖，无须事先准备静态模型表。 */
export function ModelCapabilityEditor({
  model,
  initial,
  overrides,
  source,
  catalogIssue,
  error,
  onDone,
  onCancel,
  onInputModeChange,
}: {
  model: string
  initial: ModelCatalogCapability
  overrides?: ModelCatalogCapability
  source: string
  catalogIssue?: 'timeout' | 'unavailable' | 'not-found'
  error?: boolean
  onDone(overrides: ModelCatalogCapability | undefined): void
  onCancel(): void
  onInputModeChange?(active: boolean): void
}) {
  const [draft, setDraft] = useState<ModelCatalogCapability | undefined>(overrides)
  const [field, setField] = useState<Field>()
  const [inputValue, setInputValue] = useState('')
  const [invalidInput, setInvalidInput] = useState(false)
  const inputActive =
    field === 'input' || field === 'effort' || field === 'context' || field === 'output'
  useEffect(() => {
    onInputModeChange?.(inputActive)
    return () => onInputModeChange?.(false)
  }, [inputActive, onInputModeChange])
  const [numberValue, setNumberValue] = useState('')
  const [invalidNumber, setInvalidNumber] = useState(false)
  const [mappingValue, setMappingValue] = useState('')
  const [invalidMapping, setInvalidMapping] = useState(false)
  const effective = mergeModelCatalogCapabilities(initial, draft)
  const label = (value: boolean | undefined) =>
    value === undefined
      ? tSync('modelCapability.unknown')
      : tSync(value ? 'modelCapability.supported' : 'modelCapability.unsupported')
  const image = effective.capabilities.input
    ? effective.capabilities.input.some(isImageInput)
    : undefined
  const thinking = getModelThinkingSupport(effective.capabilities.thinking)
  const number = (value: string | number | undefined) =>
    value === undefined ? tSync('modelCapability.unknown') : String(value)
  const saveFlag = (value: string) => {
    const capabilities = { ...draft?.capabilities }
    if (field === 'image') {
      if (value === 'unknown') {
        delete capabilities.input
      } else {
        const input = effective.capabilities.input ?? ['text']
        capabilities.input =
          value === 'yes'
            ? input.some(isImageInput)
              ? input
              : [...input, 'image']
            : input.filter((item) => !isImageInput(item))
      }
    } else if (field === 'thinking') {
      if (value === 'unknown') {
        delete capabilities.thinking
      } else {
        capabilities.thinking =
          value === 'yes'
            ? getModelThinkingSupport(effective.capabilities.thinking)
              ? effective.capabilities.thinking
              : { effort: ['off', 'on'] }
            : { effort: ['off'] }
      }
    } else {
      if (value === 'unknown') {
        delete capabilities.structured_outputs
      } else {
        capabilities.structured_outputs = value === 'yes'
      }
    }
    setDraft({ ...draft, capabilities })
    setField(undefined)
  }
  if (field === 'input') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>{tSync('modelCapability.inputTypes')}</Text>
        <Text dimColor>{tSync('modelCapability.inputTypesHint')}</Text>
        {invalidInput && <Text color="error">{tSync('modelCapability.invalidInputTypes')}</Text>}
        <Select
          options={[
            {
              type: 'input',
              label: tSync('modelCapability.inputTypes'),
              value: 'input',
              initialValue: inputValue,
              onChange: setInputValue,
            },
            { value: 'source', label: tSync('modelCapability.followSource') },
          ]}
          onChange={(value) => {
            const capabilities = { ...draft?.capabilities }
            if (value === 'source') delete capabilities.input
            else {
              const values = [...new Set(inputValue.split(/[,，\s]+/).filter(Boolean))]
              if (!values.length || !values.every(isModelInputModality)) {
                setInvalidInput(true)
                return
              }
              capabilities.input = values
            }
            setDraft({ ...draft, capabilities })
            setField(undefined)
          }}
          onCancel={() => setField(undefined)}
        />
      </Box>
    )
  }
  if (field === 'effort') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>{tSync('modelCapability.effort')}</Text>
        <Text dimColor>{tSync('modelCapability.effortHint')}</Text>
        <Text dimColor>{tSync('modelCapability.effortExample')}</Text>
        {invalidMapping && <Text color="error">{tSync('modelCapability.invalidMapping')}</Text>}
        <Select
          options={[
            {
              type: 'input',
              label: tSync('modelCapability.effortJson'),
              value: 'mapping',
              initialValue: mappingValue,
              onChange: setMappingValue,
            },
            { value: 'source', label: tSync('modelCapability.followSource') },
          ]}
          inlineDescriptions
          onChange={(value) => {
            const capabilities = { ...draft?.capabilities }
            if (value === 'source') {
              const thinking = removeThinkingEffortOverride(capabilities.thinking)
              if (thinking) {
                capabilities.thinking = thinking
              } else {
                delete capabilities.thinking
              }
            } else {
              const effort = parseEffortMapping(mappingValue)
              if (!effort) {
                setInvalidMapping(true)
                return
              }
              capabilities.thinking = { ...effective.capabilities.thinking, effort }
            }
            setDraft({ ...draft, capabilities })
            setField(undefined)
          }}
          onCancel={() => setField(undefined)}
        />
      </Box>
    )
  }
  if (field === 'context' || field === 'output') {
    const saveNumber = () => {
      const trimmed = numberValue.trim()
      if (
        trimmed &&
        (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(Number(trimmed)) || Number(trimmed) <= 0)
      ) {
        setInvalidNumber(true)
        return
      }
      const tokens = { ...draft?.tokens }
      const key = field === 'context' ? 'contextWindow' : 'maxOutputTokens'
      if (trimmed) {
        tokens[key] = Number(trimmed)
      } else {
        delete tokens[key]
      }
      setDraft({ ...draft, capabilities: draft?.capabilities ?? {}, tokens })
      setField(undefined)
    }
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>{tSync(`modelCapability.${field}`)}</Text>
        <Text dimColor>{tSync('modelCapability.numberHint')}</Text>
        {invalidNumber && <Text color="error">{tSync('modelCapability.invalidNumber')}</Text>}
        <Select
          options={[
            {
              type: 'input',
              label: tSync('modelCapability.tokens'),
              value: 'number',
              initialValue: numberValue,
              onChange: setNumberValue,
              allowEmptySubmitToCancel: true,
            },
          ]}
          onChange={saveNumber}
          onCancel={() => setField(undefined)}
        />
      </Box>
    )
  }
  if (field) {
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>{tSync(`modelCapability.${field}`)}</Text>
        <Select
          options={[
            { value: 'yes', label: tSync('modelCapability.supported') },
            { value: 'no', label: tSync('modelCapability.unsupported') },
            { value: 'unknown', label: tSync('modelCapability.followSource') },
          ]}
          onChange={saveFlag}
          onCancel={() => setField(undefined)}
        />
      </Box>
    )
  }
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>{tSync('modelCapability.title', { model })}</Text>
      <Text dimColor>
        {tSync('modelCapability.source', { source: tSync(`modelCapability.source.${source}`) })}
      </Text>
      <Text dimColor>{tSync('modelCapability.hint')}</Text>
      {catalogIssue && (
        <Text color="warning">{tSync(`modelCapability.catalogIssue.${catalogIssue}`)}</Text>
      )}
      <Text dimColor>{tSync('modelCapability.autoModeHint')}</Text>
      {error && <Text color="error">{tSync('onboarding.models.capabilitySaveFailed')}</Text>}
      <Select
        options={[
          { value: 'use', label: tSync('modelCapability.useModel') },
          { value: 'image', label: tSync('modelCapability.image'), description: label(image) },
          {
            value: 'thinking',
            label: tSync('modelCapability.thinking'),
            description: label(thinking),
          },
          {
            value: 'structured',
            label: tSync('modelCapability.structured'),
            description: label(effective.capabilities.structured_outputs),
          },
          {
            value: 'context',
            label: tSync('modelCapability.context'),
            description: number(effective.tokens?.contextWindow),
          },
          {
            value: 'output',
            label: tSync('modelCapability.output'),
            description: number(effective.tokens?.maxOutputTokens),
          },
          {
            value: 'effort',
            label: tSync('modelCapability.effort'),
            description: effective.capabilities.thinking?.effort
              ? JSON.stringify(effective.capabilities.thinking.effort)
              : tSync('modelCapability.unknown'),
          },
          {
            value: 'input',
            label: tSync('modelCapability.inputTypes'),
            description:
              effective.capabilities.input?.join(', ') ?? tSync('modelCapability.unknown'),
          },
        ]}
        onChange={(value) => {
          if (value === 'use') {
            onDone(draft)
            return
          }
          if (
            value !== 'input' &&
            value !== 'image' &&
            value !== 'thinking' &&
            value !== 'structured' &&
            value !== 'context' &&
            value !== 'output' &&
            value !== 'effort'
          ) {
            return
          }
          setInvalidInput(false)
          setInputValue(effective.capabilities.input?.join(', ') ?? '')
          setInvalidNumber(false)
          setInvalidMapping(false)
          setMappingValue(JSON.stringify(effective.capabilities.thinking?.effort ?? ['off', 'on']))
          setNumberValue('')
          setField(value)
        }}
        onCancel={onCancel}
      />
    </Box>
  )
}
