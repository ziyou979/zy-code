import chalk from 'chalk'
import figures from 'figures'
import * as React from 'react'
import { useEffect, useState } from 'react'
import { tSync } from '../i18n/index.js'
import { Text } from '../ink.js'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import { toError } from '../utils/errors.js'
import { logError } from '../utils/log.js'
import { getSettingSourceName } from '../utils/settings/constants.js'
import { updateSettingsForSource } from '../utils/settings/settings.js'
import { getEnvironmentSelectionInfo } from '../utils/teleport/environmentSelection.js'
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
  const [loadingState, setLoadingState] = useState('loading')
  const [environments, setEnvironments] = useState([])
  const [selectedEnvironment, setSelectedEnvironment] = useState(null)
  const [selectedEnvironmentSource, setSelectedEnvironmentSource] = useState(null)
  const [error, setError] = useState(null)
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
  const handleSelect = function handleSelect(value) {
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
function EnvironmentLabel({ environment }: any) {
  return (
    <Text>
      {figures.tick} Using {<Text bold={true}>{(environment as any).name}</Text>}{' '}
      {<Text dimColor={true}>({(environment as any).environment_id})</Text>}
    </Text>
  )
}
function SingleEnvironmentContent({ environment, onDone }) {
  useKeybinding('confirm:yes', onDone, {
    context: 'Confirmation',
  })
  // @ts-ignore
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
}) {
  const sourceSuffix =
    selectedEnvironmentSource && selectedEnvironmentSource !== 'localSettings'
      ? ` ${tSync('remoteEnv.fromSettings', { source: getSettingSourceName(selectedEnvironmentSource) })}`
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
