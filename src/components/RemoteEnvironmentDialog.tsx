import chalk from 'chalk'
import { useEffect, useState } from 'react'
import { TICK } from '../constants/figures.js'
import { tSync } from '../i18n/index.js'
import { Text } from '../ink.js'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import { getEnvironmentSelectionInfo } from '../services/teleport/environmentSelection.js'
import type { EnvironmentResource } from '../services/teleport/environments.js'
import { toError } from '../utils/errors.js'
import { logError } from '../utils/log.js'
import { getSettingSourceName } from '../services/settings/constants.js'
import { updateSettingsForSource } from '../services/settings/settings.js'
import { ConfigurableShortcutHint } from './ConfigurableShortcutHint.js'
import { Select } from './CustomSelect/select.js'
import { Byline } from './design-system/Byline.js'
import { Dialog } from './design-system/Dialog.js'
import { KeyboardShortcutHint } from './design-system/KeyboardShortcutHint.js'
import { LoadingState } from './design-system/LoadingState.js'

type Props = {
  onDone: (message?: string) => void
}
type LoadingState = 'loading' | 'updating' | null
export function RemoteEnvironmentDialog({ onDone }: Props) {
  const [loadingState, setLoadingState] = useState<string | null>('loading')
  const [environments, setEnvironments] = useState<EnvironmentResource[]>([])
  const [selectedEnvironment, setSelectedEnvironment] = useState<EnvironmentResource | null>(null)
  const [selectedEnvironmentSource, setSelectedEnvironmentSource] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    const fetchInfo = async function fetchInfo() {
      try {
        const result = await getEnvironmentSelectionInfo()
        if (cancelled) {
          return
        }
        setEnvironments(result.availableEnvironments)
        setSelectedEnvironment(result.selectedEnvironment)
        setSelectedEnvironmentSource(result.selectedEnvironmentSource)
        setLoadingState(null)
      } catch (err) {
        if (cancelled) {
          return
        }
        const fetchError = toError(err)
        logError(fetchError)
        setError(fetchError.message)
        setLoadingState(null)
      }
    }
    fetchInfo()
    return () => {
      cancelled = true
    }
  }, [])
  const handleSelect = function handleSelect(value: string) {
    if (value === 'cancel') {
      onDone()
      return
    }
    setLoadingState('updating')
    const selectedEnv = environments.find((env) => env.environment_id === value)
    if (!selectedEnv) {
      onDone(tSync('remoteEnv.errorLabel', { error: 'Selected environment not found' }))
      return
    }
    updateSettingsForSource('localSettings', {
      remote: {
        defaultEnvironmentId: selectedEnv.environment_id,
      },
    })
    onDone(
      `Set default remote environment to ${chalk.bold(selectedEnv.name)} (${selectedEnv.environment_id})`,
    )
  }
  if (loadingState === 'loading') {
    return (
      <Dialog title={tSync('remoteEnv.title')} onCancel={onDone} hideInputGuide={true}>
        {<LoadingState message={tSync('remoteEnv.loading')} />}
      </Dialog>
    )
  }
  if (error) {
    return (
      <Dialog title={tSync('remoteEnv.title')} onCancel={onDone}>
        {<Text color="error">{tSync('remoteEnv.errorLabel', { error })}</Text>}
      </Dialog>
    )
  }
  if (!selectedEnvironment) {
    return (
      <Dialog
        title={tSync('remoteEnv.title')}
        subtitle={tSync('remoteEnv.configHint')}
        onCancel={onDone}
      >
        {<Text>{tSync('remoteEnv.noEnvironments')}</Text>}
      </Dialog>
    )
  }
  if (environments.length === 1) {
    return <SingleEnvironmentContent environment={selectedEnvironment} onDone={onDone} />
  }
  return (
    <MultipleEnvironmentsContent
      environments={environments}
      selectedEnvironment={selectedEnvironment}
      selectedEnvironmentSource={selectedEnvironmentSource}
      loadingState={loadingState}
      onSelect={handleSelect}
      onCancel={onDone}
    />
  )
}
function EnvironmentLabel({ environment }: { environment: EnvironmentResource }) {
  return (
    <Text>
      {TICK} Using {<Text bold={true}>{environment.name}</Text>}{' '}
      {<Text dimColor={true}>({environment.environment_id})</Text>}
    </Text>
  )
}
function SingleEnvironmentContent({
  environment,
  onDone,
}: {
  environment: EnvironmentResource
  onDone: () => void
}) {
  useKeybinding('confirm:yes', onDone, {
    context: 'Confirmation',
  })
  return (
    <Dialog
      title={tSync('remoteEnv.title')}
      subtitle={tSync('remoteEnv.configHint')}
      onCancel={onDone}
    >
      {<EnvironmentLabel environment={environment} />}
    </Dialog>
  )
}
function MultipleEnvironmentsContent({
  environments,
  selectedEnvironment,
  selectedEnvironmentSource,
  loadingState,
  onSelect,
  onCancel,
}: {
  environments: EnvironmentResource[]
  selectedEnvironment: EnvironmentResource
  selectedEnvironmentSource: string | null
  loadingState: string | null
  onSelect: (value: string) => void
  onCancel: () => void
}) {
  const sourceSuffix =
    selectedEnvironmentSource && selectedEnvironmentSource !== 'localSettings'
      ? ` ${tSync('remoteEnv.fromSettings', { source: getSettingSourceName(selectedEnvironmentSource as import('../services/settings/constants.js').SettingSource) })}`
      : ''
  const subtitle = (
    <Text>
      {tSync('remoteEnv.currentlyUsing')}: {<Text bold={true}>{selectedEnvironment.name}</Text>}
      {sourceSuffix}
    </Text>
  )
  return (
    <Dialog
      title={tSync('remoteEnv.title')}
      subtitle={subtitle}
      onCancel={onCancel}
      hideInputGuide={true}
    >
      {<Text dimColor={true}>{tSync('remoteEnv.configHint')}</Text>}
      {loadingState === 'updating' ? (
        <LoadingState message={tSync('remoteEnv.updating')} />
      ) : (
        <Select
          options={environments.map((env) => ({
            label: (
              <Text>
                {env.name} <Text dimColor={true}>({env.environment_id})</Text>
              </Text>
            ),
            value: env.environment_id,
          }))}
          defaultValue={selectedEnvironment.environment_id}
          onChange={onSelect}
          onCancel={() => onSelect('cancel')}
          layout="compact-vertical"
        />
      )}
      {
        <Text dimColor={true}>
          <Byline>
            <KeyboardShortcutHint shortcut="Enter" action="select" />
            <ConfigurableShortcutHint
              action="confirm:no"
              context="Confirmation"
              fallback="Esc"
              description={tSync('remoteEnv.cancel')}
            />
          </Byline>
        </Text>
      }
    </Dialog>
  )
}
