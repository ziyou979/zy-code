import { useEffect, useState } from 'react'
import { tSync } from '../../i18n/index.js'
import { Select } from '../CustomSelect/index.js'
import { Pane } from '../design-system/Pane.js'
import { Spinner } from '../Spinner.js'
import { useExitOnCtrlCDWithKeybindings } from '../../hooks/useExitOnCtrlCDWithKeybindings.js'
// eslint-disable-next-line custom-rules/prefer-use-keybindings -- enter to proceed through setup steps
import { Box, Text, useInput } from '../../ink.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import {
  detectPythonPackageManager,
  getPythonApiInstructions,
  installIt2,
  markIt2SetupComplete,
  type PythonPackageManager,
  setPreferTmuxOverIterm2,
  verifyIt2Setup,
} from '../../services/swarm/backends/it2Setup.js'

type SetupStep =
  | 'initial'
  | 'installing'
  | 'install-failed'
  | 'verify-api'
  | 'api-instructions'
  | 'verifying'
  | 'success'
  | 'failed'
type Props = {
  onDone: (result: 'installed' | 'use-tmux' | 'cancelled') => void
  tmuxAvailable: boolean
}
export function It2SetupPrompt({ onDone, tmuxAvailable }: Props) {
  const [step, setStep] = useState('initial')
  const [packageManager, setPackageManager] = useState<PythonPackageManager | null>(null)
  const [error, setError] = useState<string | null>(null)
  const exitState = useExitOnCtrlCDWithKeybindings()
  useEffect(() => {
    detectPythonPackageManager().then((pm) => {
      setPackageManager(pm)
    })
  }, [])
  const handleCancel = () => {
    onDone('cancelled')
  }
  useKeybinding('confirm:no', handleCancel, {
    context: 'Confirmation',
    isActive: step !== 'installing' && step !== 'verifying',
  })
  useInput((_input, key) => {
    if (step === 'api-instructions' && key.return) {
      setStep('verifying')
      verifyIt2Setup().then((result) => {
        if (result.success) {
          markIt2SetupComplete()
          setStep('success')
          setTimeout(onDone, 1500, 'installed' as const)
        } else {
          setError(result.error || tSync('it2Setup.verificationFailed'))
          setStep('failed')
        }
      })
    }
  })
  const handleInstall = async function handleInstall() {
    if (!packageManager) {
      setError(tSync('it2Setup.noPackageManager'))
      setStep('failed')
      return
    }
    setStep('installing')
    const result_0 = await installIt2(packageManager)
    if (result_0.success) {
      setStep('api-instructions')
    } else {
      setError(result_0.error || tSync('it2Setup.installFailed'))
      setStep('install-failed')
    }
  }
  const handleUseTmux = function handleUseTmux() {
    setPreferTmuxOverIterm2(true)
    onDone('use-tmux')
  }
  let BoxComponent
  let PaneComponent

  let renderContentResult

  const renderContent = () => {
    switch (step) {
      case 'initial': {
        return renderInitialPrompt()
      }
      case 'installing': {
        return renderInstalling()
      }
      case 'install-failed': {
        return renderInstallFailed()
      }
      case 'api-instructions': {
        return renderApiInstructions()
      }
      case 'verifying': {
        return renderVerifying()
      }
      case 'success': {
        return renderSuccess()
      }
      case 'failed': {
        return renderFailed()
      }
      default: {
        return null
      }
    }
  }
  function renderInitialPrompt() {
    const options = [
      {
        label: tSync('it2Setup.installNow'),
        value: 'install',
        description: packageManager
          ? tSync('it2Setup.usesPackageManager', { packageManager })
          : tSync('it2Setup.requiresPython'),
      },
    ]
    if (tmuxAvailable) {
      options.push({
        label: tSync('it2Setup.useTmux'),
        value: 'tmux',
        description: tSync('it2Setup.useTmuxDesc'),
      })
    }
    options.push({
      label: tSync('it2Setup.cancel'),
      value: 'cancel',
      description: tSync('it2Setup.cancelDesc'),
    })
    return (
      <Box flexDirection="column" gap={1}>
        <Text>
          {tSync('it2Setup.needIt2CLI')} <Text bold={true}>it2</Text>{' '}
          {tSync('it2Setup.needIt2CLI2')}
        </Text>
        <Text dimColor={true}>{tSync('it2Setup.splitPanesDesc')}</Text>
        <Box marginTop={1}>
          <Select
            options={options}
            onChange={(value: string) => {
              switch (value) {
                case 'install': {
                  handleInstall()
                  break
                }
                case 'tmux': {
                  handleUseTmux()
                  break
                }
                case 'cancel': {
                  onDone('cancelled')
                }
              }
            }}
            onCancel={() => onDone('cancelled')}
          />
        </Box>
      </Box>
    )
  }
  function renderInstalling() {
    return (
      <Box flexDirection="column" gap={1}>
        <Box>
          <Spinner />
          <Text>
            {' '}
            {tSync('it2Setup.installingUsing', { packageManager: packageManager ?? '' })}
          </Text>
        </Box>
        <Text dimColor={true}>{tSync('it2Setup.installMayTakeMoment')}</Text>
      </Box>
    )
  }
  function renderInstallFailed() {
    const installOptions = [
      {
        label: tSync('it2Setup.tryAgain'),
        value: 'retry',
        description: tSync('it2Setup.retryInstallDesc'),
      },
    ]
    if (tmuxAvailable) {
      installOptions.push({
        label: tSync('it2Setup.useTmux'),
        value: 'tmux',
        description: tSync('it2Setup.fallbackTmuxDesc'),
      })
    }
    installOptions.push({
      label: tSync('it2Setup.cancel'),
      value: 'cancel',
      description: tSync('it2Setup.cancelDesc'),
    })
    return (
      <Box flexDirection="column" gap={1}>
        <Text color="error">{tSync('it2Setup.installFailed')}</Text>
        {error && <Text dimColor={true}>{error}</Text>}
        <Text dimColor={true}>
          {tSync('it2Setup.tryManualInstall')}{' '}
          {packageManager === 'uvx'
            ? tSync('it2Setup.manualCmdUvx')
            : packageManager === 'pipx'
              ? tSync('it2Setup.manualCmdPipx')
              : tSync('it2Setup.manualCmdPip')}
        </Text>
        <Box marginTop={1}>
          <Select
            options={installOptions}
            onChange={(selectedValue: string) => {
              switch (selectedValue) {
                case 'retry': {
                  handleInstall()
                  break
                }
                case 'tmux': {
                  handleUseTmux()
                  break
                }
                case 'cancel': {
                  onDone('cancelled')
                }
              }
            }}
            onCancel={() => onDone('cancelled')}
          />
        </Box>
      </Box>
    )
  }
  function renderApiInstructions() {
    const instructions = getPythonApiInstructions()
    return (
      <Box flexDirection="column" gap={1}>
        <Text color="success">{tSync('it2Setup.installedSuccessfully')}</Text>
        <Box flexDirection="column" marginTop={1}>
          {instructions.map((line, i) => (
            <Text key={i}>{line}</Text>
          ))}
        </Box>
        <Box marginTop={1}>
          <Text dimColor={true}>{tSync('it2Setup.pressEnterVerify')}</Text>
        </Box>
      </Box>
    )
  }
  function renderVerifying() {
    return (
      <Box>
        <Spinner />
        <Text> {tSync('it2Setup.verifyingCommunication')}</Text>
      </Box>
    )
  }
  function renderSuccess() {
    return (
      <Box flexDirection="column">
        <Text color="success">{tSync('it2Setup.splitPaneReady')}</Text>
        <Text dimColor={true}>{tSync('it2Setup.splitPaneTeammates')}</Text>
      </Box>
    )
  }
  function renderFailed() {
    const enableOptions = [
      {
        label: tSync('it2Setup.tryAgain'),
        value: 'retry',
        description: tSync('it2Setup.verifyAgainDesc'),
      },
    ]
    if (tmuxAvailable) {
      enableOptions.push({
        label: tSync('it2Setup.useTmux'),
        value: 'tmux',
        description: tSync('it2Setup.fallbackTmuxDesc'),
      })
    }
    enableOptions.push({
      label: tSync('it2Setup.cancel'),
      value: 'cancel',
      description: tSync('it2Setup.cancelDesc'),
    })
    return (
      <Box flexDirection="column" gap={1}>
        <Text color="error">{tSync('it2Setup.verificationFailed')}</Text>
        {error && <Text dimColor={true}>{error}</Text>}
        <Text>{tSync('it2Setup.makeSure')}</Text>
        <Box flexDirection="column" paddingLeft={2}>
          <Text>{tSync('it2Setup.enablePythonApi')}</Text>
          <Text>{tSync('it2Setup.restartIterm2')}</Text>
        </Box>
        <Box marginTop={1}>
          <Select
            options={enableOptions}
            onChange={(selectedValue: string) => {
              switch (selectedValue) {
                case 'retry': {
                  setStep('verifying')
                  verifyIt2Setup().then((verificationResult) => {
                    if (verificationResult.success) {
                      markIt2SetupComplete()
                      setStep('success')
                      setTimeout(onDone, 1500, 'installed' as const)
                    } else {
                      setError(verificationResult.error || tSync('it2Setup.verificationFailed'))
                      setStep('failed')
                    }
                  })
                  break
                }
                case 'tmux': {
                  handleUseTmux()
                  break
                }
                case 'cancel': {
                  onDone('cancelled')
                }
              }
            }}
            onCancel={() => onDone('cancelled')}
          />
        </Box>
      </Box>
    )
  }
  PaneComponent = Pane

  BoxComponent = Box

  const textElement = (
    <Text bold={true} color="permission">
      {tSync('it2Setup.title')}
    </Text>
  )
  renderContentResult = renderContent()
  return (
    <PaneComponent color={'permission'}>
      {
        <BoxComponent flexDirection={'column'} gap={1} paddingBottom={1}>
          {textElement}
          {renderContentResult}
          {step !== 'installing' && step !== 'verifying' && step !== 'success' && (
            <Text dimColor={true} italic={true}>
              {exitState.pending ? (
                <>{tSync('it2Setup.pressAgainToExit', { keyName: exitState.keyName ?? '' })}</>
              ) : (
                <>{tSync('it2Setup.escToCancel')}</>
              )}
            </Text>
          )}
        </BoxComponent>
      }
    </PaneComponent>
  )
}
