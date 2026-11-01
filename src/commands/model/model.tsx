import chalk from 'chalk'
import * as React from 'react'
import { setMainLoopModelOverride } from '../../bootstrap/runtime/runtimeContext.js'
import type { CommandResultDisplay } from '../../commands/index.js'
import { ModelPicker } from '../../components/ModelPicker.js'
import { ModelTierConfigFlow } from '../../components/ModelTierConfigDialog.js'
import { COMMON_HELP_ARGS, COMMON_INFO_ARGS } from '../../constants/xml.js'
import { tSync } from '../../i18n/index.js'
import { Box, Text } from '../../ink/index.js'
import { saveMainLoopModelSetting } from '../../services/settings/modelTierSettings.js'
import { getInitialSettings } from '../../services/settings/settings.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { isKnownModelAlias } from '../../services/model/aliases.js'
import {
  getDefaultMainLoopModelSetting,
  renderDefaultModelSetting,
} from '../../services/model/model.js'
import { isModelAllowed } from '../../services/model/modelAllowlist.js'
import { validateModel } from '../../services/model/validateModel.js'
import { useAppState, useSetAppState } from '../../state/AppState.js'
import type { LocalJSXCommandCall, LocalJSXCommandOnDone } from '../types.js'
import { resolveEffortForModelSetting } from '../../services/effort/effort.js'
import { shouldEnableThinkingByDefault } from '../../services/messages/thinking.js'
import { renderModelLabel } from './performModelChange.js'

function ModelPickerWrapper({ onDone }: { onDone: LocalJSXCommandOnDone }) {
  const [isConfiguringTiers, setIsConfiguringTiers] = React.useState(false)
  const [saveError, setSaveError] = React.useState(false)
  const mainLoopModel = useAppState((s) => s.mainLoopModel)
  const mainLoopModelForSession = useAppState((state) => state.mainLoopModelForSession)
  const setAppState = useSetAppState()

  if (isConfiguringTiers) {
    return (
      <ModelTierConfigFlow
        onDone={(msg) => onDone(msg ?? tSync('settings.modelConfigUpdated'))}
        onCancel={() => setIsConfiguringTiers(false)}
      />
    )
  }
  const handleCancel = function handleCancel() {
    logEvent('zy_model_command_menu', {
      action: 'cancel' as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    const displayModel = renderModelLabel(mainLoopModel)
    onDone(tSync('modelCommand.kept', { model: chalk.bold(displayModel) }), {
      display: 'system',
    })
  }
  const handleSelect = function handleSelect(model: string | null, effort?: string) {
    // 同一档位内换候选时 mainLoopModel 不变，状态差异回调不会清除旧覆盖。
    if (model === mainLoopModel) {
      if (saveMainLoopModelSetting(model).error) {
        setSaveError(true)
        return
      }
      setMainLoopModelOverride(model)
    }
    logEvent('zy_model_command_menu', {
      action: model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      from_model: mainLoopModel as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
      to_model: model as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    setAppState((prev) => ({
      ...prev,
      mainLoopModel: model,
      mainLoopModelForSession: null,
      effortValue: resolveEffortForModelSetting(model, prev.effortValue),
      // 按新模型能力重置 thinking 开关，避免来自 /clear 或之前不支持 thinking
      // 的模型的过期 false 值被保留。
      thinkingEnabled: shouldEnableThinkingByDefault(model ?? undefined),
    }))
    setAppState((prev) => ({ ...prev, settings: getInitialSettings() }))
    let message = tSync('modelCommand.set', { model: chalk.bold(renderModelLabel(model)) })
    if (effort !== undefined) {
      const effortDisplay = tSync(`effort.${effort}`) || effort
      message = tSync('modelCommand.setWithEffort', {
        model: chalk.bold(renderModelLabel(model)),
        effort: chalk.bold(effortDisplay),
      })
    }
    onDone(message)
  }
  return (
    <Box flexDirection="column">
      {saveError && <Text color="error">{tSync('settings.modelConfigSaveFailed')}</Text>}
      <ModelPicker
        initial={mainLoopModel}
        sessionModel={mainLoopModelForSession}
        onSelect={handleSelect}
        onCancel={handleCancel}
        onConfigureTiers={() => setIsConfiguringTiers(true)}
        isStandaloneCommand={true}
      />
    </Box>
  )
}
function SetModelAndClose({
  args,
  onDone,
}: {
  args: string
  onDone: (
    result?: string,
    options?: {
      display?: CommandResultDisplay
    },
  ) => void
}): React.ReactNode {
  const setAppState = useSetAppState()
  const model = args === 'default' ? null : args
  React.useEffect(() => {
    async function handleModelChange(): Promise<void> {
      if (model && !isModelAllowed(model)) {
        onDone(tSync('modelCommand.notAvailable', { model }), {
          display: 'system',
        })
        return
      }

      // Skip validation for default model
      if (!model) {
        setModel(null)
        return
      }

      // Skip validation for known aliases - they're predefined and should work
      if (isKnownModelAlias(model)) {
        setModel(model)
        return
      }

      // Validate and set custom model
      try {
        // Don't use parseUserSpecifiedModel for non-aliases since it lowercases the input
        // and model names are case-sensitive
        const { valid, error: error_0 } = await validateModel(model)
        if (valid) {
          setModel(model)
        } else {
          onDone(error_0 || tSync('modelCommand.notFound', { model }), {
            display: 'system',
          })
        }
      } catch (error) {
        onDone(tSync('modelCommand.validateFailed', { error: (error as Error).message }), {
          display: 'system',
        })
      }
    }
    function setModel(modelValue: string | null): void {
      setAppState((prev) => ({
        ...prev,
        mainLoopModel: modelValue,
        mainLoopModelForSession: null,
        // 切模型时保留用户意图，但必须落到新模型支持的档位内。
        effortValue: resolveEffortForModelSetting(modelValue, prev.effortValue),
        // 按新模型能力重置 thinking 开关，避免过期 false 值被保留
        thinkingEnabled: shouldEnableThinkingByDefault(modelValue ?? undefined),
      }))
      const message = tSync('modelCommand.set', {
        model: chalk.bold(renderModelLabel(modelValue)),
      })
      onDone(message)
    }
    void handleModelChange()
  }, [model, onDone, setAppState])
  return null
}
function ShowModelAndClose(props: { onDone: LocalJSXCommandOnDone }) {
  const { onDone } = props
  const mainLoopModel = useAppState((state) => state.mainLoopModel)
  const mainLoopModelForSession = useAppState((state) => state.mainLoopModelForSession)
  const effortValue = useAppState((state) => state.effortValue)
  const displayModel = renderModelLabel(mainLoopModel)
  const effortInfo = effortValue !== undefined ? ` (effort: ${effortValue})` : ''
  if (mainLoopModelForSession) {
    onDone(
      tSync('modelCommand.currentSessionOverride', {
        model: chalk.bold(renderModelLabel(mainLoopModelForSession)),
        base: displayModel,
        effort: effortInfo,
      }),
    )
  } else {
    onDone(tSync('modelCommand.current', { model: displayModel }) + effortInfo)
  }
  return null
}
export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  args = args?.trim() || ''
  if (COMMON_INFO_ARGS.includes(args)) {
    logEvent('zy_model_command_inline_help', {
      args: args as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return <ShowModelAndClose onDone={onDone} />
  }
  if (COMMON_HELP_ARGS.includes(args)) {
    onDone(tSync('modelCommand.help'), {
      display: 'system',
    })
    return
  }
  if (args) {
    logEvent('zy_model_command_inline', {
      args: args as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
    })
    return <SetModelAndClose args={args} onDone={onDone} />
  }
  return <ModelPickerWrapper onDone={onDone} />
}
