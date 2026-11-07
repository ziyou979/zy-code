import { useEffect, useRef, useState } from 'react'
import { tSync } from '../i18n/index.js'
import { Box, Link, Text } from '../ink/index.js'
import { useKeybinding } from '../keybindings/useKeybinding.js'
import {
  getAuthConfigForProvider,
  getConfiguredConnectionIds,
} from '../services/auth/authConfig.js'
import {
  getDefaultGoogleAdcFile,
  isGoogleAdcConnection,
  loginGoogleAdc,
  verifyGoogleAdcSource,
  verifyGoogleCloudCli,
} from '../services/auth/googleAdc.js'
import {
  createVertexSetupDraft,
  isValidVertexProjectId,
  normalizeVertexInputPath,
  saveVertexSetup,
  VertexSetupClient,
  VertexSetupApiError,
  type VertexProject,
  type VertexProjectChecks,
  type VertexSetupDraft,
} from '../services/auth/vertexSetup.js'
import { openBrowser } from '../services/browser/browser.js'
import { Select } from './CustomSelect/select.js'
import { Spinner } from './Spinner.js'

type Phase =
  | 'connections'
  | 'intro'
  | 'credentials'
  | 'gcloud'
  | 'gcloudPath'
  | 'file'
  | 'projects'
  | 'projectInput'
  | 'location'
  | 'locationInput'
  | 'checks'
  | 'summary'
  | 'connectionName'
const inputPhases: Phase[] = [
  'gcloudPath',
  'file',
  'projectInput',
  'locationInput',
  'connectionName',
]
const cliDocs = 'https://cloud.google.com/sdk/docs/install'
const adcDocs = 'https://cloud.google.com/docs/authentication/set-up-adc-local-dev-environment'

function previousPhase(phase: Phase, hasConnections: boolean): Phase {
  switch (phase) {
    case 'connections':
      return 'connections'
    case 'intro':
      return hasConnections ? 'connections' : 'intro'
    case 'credentials':
      return 'intro'
    case 'gcloud':
    case 'file':
    case 'projects':
      return 'credentials'
    case 'gcloudPath':
      return 'gcloud'
    case 'projectInput':
    case 'location':
      return 'projects'
    case 'locationInput':
    case 'checks':
      return 'location'
    case 'summary':
      return 'checks'
    case 'connectionName':
      return 'summary'
  }
}

export function VertexLogin({
  onDone,
  onBack,
  onInputModeChange,
}: {
  onDone(connectionId: string): void
  onBack(): void
  onInputModeChange?(active: boolean): void
}) {
  const connections = getConfiguredConnectionIds().filter(isGoogleAdcConnection)
  const [phase, setPhase] = useState<Phase>(connections.length ? 'connections' : 'intro')
  const [draft, setDraft] = useState<VertexSetupDraft>(() => createVertexSetupDraft())
  const [projects, setProjects] = useState<VertexProject[]>([])
  const [checks, setChecks] = useState<VertexProjectChecks>()
  const [busyKey, setBusyKey] = useState<string>()
  const [error, setError] = useState<string>()
  const [authUrl, setAuthUrl] = useState<string>()
  const controller = useRef<AbortController | null>(null)
  const focused = useRef<{ phase: Phase; value: string } | undefined>(undefined)
  const accept = useRef<() => void>(() => {})
  const isInput = inputPhases.includes(phase) && !busyKey
  useEffect(() => () => controller.current?.abort(), [])
  useEffect(() => {
    onInputModeChange?.(isInput)
    return () => onInputModeChange?.(false)
  }, [isInput, onInputModeChange])

  function go(next: Phase) {
    controller.current?.abort()
    setBusyKey(undefined)
    setError(undefined)
    setAuthUrl(undefined)
    setPhase(next)
  }
  function back() {
    if (phase === 'connections' || (phase === 'intro' && !connections.length)) {
      controller.current?.abort()
      onBack()
    } else {
      go(previousPhase(phase, connections.length > 0))
    }
  }
  // Dialog 的 Confirmation 上下文优先于 Select；输入页禁用它，避免 n 被当作取消。
  useKeybinding('confirm:yes', () => accept.current(), {
    context: 'Confirmation',
    isActive: !isInput && !busyKey,
  })
  useKeybinding('confirm:no', back, { context: 'Confirmation', isActive: !isInput })

  function run<T>(
    key: string,
    action: (signal: AbortSignal) => Promise<T>,
    success: (value: T) => void,
    errorPhase: Phase = phase,
  ) {
    controller.current?.abort()
    const current = new AbortController()
    controller.current = current
    setBusyKey(key)
    setError(undefined)
    void action(current.signal)
      .then((value) => {
        if (!current.signal.aborted) {
          success(value)
        }
      })
      .catch((failure: unknown) => {
        if (!current.signal.aborted) {
          setError(failure instanceof Error ? failure.message : tSync('vertex.loginFailed'))
          setPhase(errorPhase)
        }
      })
      .finally(() => {
        if (controller.current === current && !current.signal.aborted) {
          setBusyKey(undefined)
        }
      })
  }

  function loadProjects(credentialsFile?: string) {
    run(
      'vertex.setup.loadingProjects',
      async (signal) => {
        await verifyGoogleAdcSource(credentialsFile)
        signal.throwIfAborted()
        try {
          return {
            projects: await new VertexSetupClient({ credentialsFile }).listProjects(signal),
            warning: undefined,
          }
        } catch (failure) {
          signal.throwIfAborted()
          if (failure instanceof VertexSetupApiError && failure.status === 401) {
            throw failure
          }
          return {
            projects: [],
            warning:
              failure instanceof Error
                ? failure.message
                : tSync('vertex.setup.projectListUnavailable'),
          }
        }
      },
      (result) => {
        setDraft((previous) => ({ ...previous, credentialsFile }))
        setProjects(result.projects)
        setError(result.warning)
        setPhase('projects')
      },
      'credentials',
    )
  }

  function browserLogin() {
    run(
      'vertex.setup.checkingCli',
      (signal) => verifyGoogleCloudCli(draft.gcloudPath ?? 'gcloud', signal),
      () => {
        run(
          'vertex.setup.authorizing',
          (signal) =>
            loginGoogleAdc({
              gcloudPath: draft.gcloudPath,
              signal,
              onAuthUrl: (url) => {
                if (!signal.aborted) {
                  setAuthUrl(url)
                }
              },
            }),
          (file) => loadProjects(file),
          'credentials',
        )
      },
      'gcloud',
    )
  }

  function inspect(location = draft.location) {
    setDraft((previous) => ({ ...previous, location }))
    setPhase('checks')
    setChecks(undefined)
    run(
      'vertex.setup.checkingProject',
      (signal) =>
        new VertexSetupClient({ credentialsFile: draft.credentialsFile }).inspectProject(
          draft.project,
          signal,
        ),
      setChecks,
      'checks',
    )
  }

  function menu(options: { label: string; value: string }[], choose: (value: string) => void) {
    accept.current = () =>
      choose(
        focused.current?.phase === phase &&
          options.some((option) => option.value === focused.current?.value)
          ? focused.current.value
          : options[0]!.value,
      )
    return (
      <Select
        key={phase}
        options={options}
        onFocus={(value) => {
          focused.current = { phase, value }
        }}
        onChange={choose}
        onCancel={back}
      />
    )
  }
  const option = (name: string, value: string) => ({ label: tSync(`vertex.setup.${name}`), value })
  const credentialPath = draft.credentialsFile ?? getDefaultGoogleAdcFile()
  const consoleProject = encodeURIComponent(draft.project)
  const apiConsole = `https://console.cloud.google.com/apis/library/aiplatform.googleapis.com?project=${consoleProject}`
  const billingConsole = `https://console.cloud.google.com/billing/linkedaccount?project=${consoleProject}`
  const iamConsole = `https://console.cloud.google.com/iam-admin/iam?project=${consoleProject}`

  let content: React.ReactNode
  if (busyKey) {
    content = (
      <>
        <Spinner />
        <Text>{tSync(busyKey)}</Text>
        {busyKey === 'vertex.setup.authorizing' && <Text>{tSync('vertex.setup.consentHint')}</Text>}
        {authUrl && <Link url={authUrl}>{tSync('vertex.openLoginPage')}</Link>}
        <Text dimColor>{tSync('vertex.setup.cancelWaiting')}</Text>
      </>
    )
  } else if (phase === 'connections') {
    content = menu(
      [
        ...connections.map((id) => ({
          value: id,
          label: `${id} · ${getAuthConfigForProvider(id)?.vertex?.project} · ${getAuthConfigForProvider(id)?.vertex?.location ?? 'global'}`,
        })),
        option('newConnection', '__new'),
      ],
      (id) => {
        setDraft(createVertexSetupDraft(id === '__new' ? undefined : id))
        go('intro')
      },
    )
  } else if (phase === 'intro') {
    content = (
      <>
        <Text>{tSync('vertex.setup.intro')}</Text>
        <Text>{tSync('vertex.setup.prerequisites')}</Text>
        <Link url={adcDocs}>{tSync('vertex.setup.adcDocs')}</Link>
        {menu([option('start', 'start'), option('back', 'back')], (value) =>
          value === 'back' ? back() : go('credentials'),
        )}
      </>
    )
  } else if (phase === 'credentials') {
    content = (
      <>
        <Text>{tSync('vertex.setup.chooseCredentials')}</Text>
        <Text dimColor>{tSync('vertex.setup.adcExplanation')}</Text>
        {credentialPath && (
          <Text>{tSync('vertex.setup.credentialPath', { path: credentialPath })}</Text>
        )}
        {menu(
          [
            ...(credentialPath ? [option('useExisting', 'existing')] : []),
            option('authorizeBrowser', 'browser'),
            option('useFile', 'file'),
            option('back', 'back'),
          ],
          (value) => {
            if (value === 'browser') {
              browserLogin()
            } else if (value === 'existing') {
              loadProjects(credentialPath)
            } else if (value === 'file') {
              go('file')
            } else {
              back()
            }
          },
        )}
      </>
    )
  } else if (phase === 'gcloud') {
    content = (
      <>
        <Text>{tSync('vertex.setup.installCli')}</Text>
        <Link url={cliDocs}>{cliDocs}</Link>
        {menu(
          [
            option('retryCli', 'retry'),
            option('enterCliPath', 'path'),
            option('useFile', 'file'),
            option('back', 'back'),
          ],
          (value) => {
            if (value === 'retry') {
              browserLogin()
            } else if (value === 'path') {
              go('gcloudPath')
            } else if (value === 'file') {
              go('file')
            } else {
              back()
            }
          },
        )}
      </>
    )
  } else if (isInput) {
    const details = {
      file: { label: tSync('vertex.setup.filePrompt'), initial: credentialPath ?? '' },
      gcloudPath: { label: tSync('vertex.setup.cliPathPrompt'), initial: draft.gcloudPath ?? '' },
      projectInput: { label: tSync('vertex.enterProject'), initial: draft.project },
      locationInput: { label: tSync('vertex.setup.locationPrompt'), initial: draft.location },
      connectionName: { label: tSync('vertex.setup.connectionName'), initial: draft.connectionId },
    }[phase as 'file' | 'gcloudPath' | 'projectInput' | 'locationInput' | 'connectionName']
    content = (
      <VertexSetupInput
        key={phase}
        label={details.label}
        initial={details.initial}
        onBack={back}
        onSubmit={(value) => {
          setError(undefined)
          if (phase === 'file') {
            loadProjects(normalizeVertexInputPath(value))
          } else if (phase === 'gcloudPath') {
            setDraft((previous) => ({ ...previous, gcloudPath: normalizeVertexInputPath(value) }))
            go('credentials')
          } else if (phase === 'projectInput') {
            if (!isValidVertexProjectId(value)) {
              setError(tSync('vertex.setup.invalidProject'))
              return
            }
            setDraft((previous) => ({ ...previous, project: value }))
            go('location')
          } else if (phase === 'locationInput') {
            if (!/^[a-z0-9-]{2,64}$/.test(value)) {
              setError(tSync('vertex.setup.invalidLocation'))
              return
            }
            inspect(value)
          } else {
            setDraft((previous) => ({ ...previous, connectionId: value }))
            go('summary')
          }
        }}
      />
    )
  } else if (phase === 'projects') {
    content = (
      <>
        <Text>{tSync('vertex.setup.chooseProject')}</Text>
        {!projects.length && <Text>{tSync('vertex.setup.projectListUnavailable')}</Text>}
        {menu(
          [
            ...projects.map((project) => ({
              value: project.id,
              label: `${project.name} · ${project.id}`,
            })),
            ...(draft.project && !projects.some((project) => project.id === draft.project)
              ? [{ value: draft.project, label: draft.project }]
              : []),
            option('manualProject', '__manual'),
            option('refreshProjects', '__refresh'),
            option('createProject', '__create'),
            option('back', '__back'),
          ],
          (value) => {
            if (value === '__manual') {
              go('projectInput')
            } else if (value === '__refresh') {
              loadProjects(draft.credentialsFile)
            } else if (value === '__create') {
              void openBrowser('https://console.cloud.google.com/projectcreate')
            } else if (value === '__back') {
              back()
            } else {
              setDraft((previous) => ({ ...previous, project: value }))
              go('location')
            }
          },
        )}
      </>
    )
  } else if (phase === 'location') {
    content = (
      <>
        <Text>{tSync('vertex.selectLocation')}</Text>
        <Text dimColor>{tSync('vertex.setup.locationHint')}</Text>
        {menu(
          [
            option('locationGlobal', 'global'),
            option('locationUs', 'us'),
            option('locationEu', 'eu'),
            option('customLocation', '__custom'),
            option('back', '__back'),
          ],
          (value) => {
            if (value === '__custom') {
              go('locationInput')
            } else if (value === '__back') {
              back()
            } else {
              inspect(value)
            }
          },
        )}
      </>
    )
  } else if (phase === 'checks') {
    const blocked = checks && Object.values(checks).includes('blocked')
    const unknown = checks && Object.values(checks).includes('unknown')
    content = (
      <>
        <Text>{tSync('vertex.setup.checksTitle')}</Text>
        {checks &&
          (Object.keys(checks) as (keyof VertexProjectChecks)[]).map((key) => (
            <Text key={key}>
              {tSync(`vertex.setup.check.${key}`)}: {tSync(`vertex.setup.status.${checks[key]}`)}
            </Text>
          ))}
        <Text dimColor>{tSync('vertex.setup.checksHint')}</Text>
        <Link url={apiConsole}>{tSync('vertex.setup.apiConsole')}</Link>
        <Link url={billingConsole}>{tSync('vertex.setup.billingConsole')}</Link>
        <Link url={iamConsole}>{tSync('vertex.setup.iamConsole')}</Link>
        {menu(
          [
            ...(checks && !blocked
              ? [option(unknown ? 'continueUnknown' : 'continue', 'next')]
              : []),
            option('recheck', 'check'),
            option('changeProject', 'project'),
            option('changeCredentials', 'credentials'),
            option('back', 'back'),
          ],
          (value) => {
            if (value === 'next') {
              go('summary')
            } else if (value === 'check') {
              inspect()
            } else if (value === 'project') {
              go('projects')
            } else if (value === 'credentials') {
              go('credentials')
            } else {
              back()
            }
          },
        )}
      </>
    )
  } else {
    content = (
      <>
        <Text>{tSync('vertex.setup.summary')}</Text>
        <Text>{tSync('vertex.setup.connectionSummary', { connection: draft.connectionId })}</Text>
        <Text>
          {tSync('vertex.loginProject', { project: draft.project, location: draft.location })}
        </Text>
        <Text>
          {tSync('vertex.setup.credentialPath', {
            path: draft.credentialsFile ?? tSync('vertex.setup.defaultAdc'),
          })}
        </Text>
        <Text>{tSync('vertex.setup.quotaHint', { project: draft.project })}</Text>
        <Text dimColor>{tSync('vertex.setup.saveHint')}</Text>
        {menu(
          [
            option('save', 'save'),
            option('rename', 'rename'),
            option('changeProject', 'project'),
            option('changeRegion', 'location'),
            option('changeCredentials', 'credentials'),
            option('back', 'back'),
          ],
          (value) => {
            if (value === 'save') {
              try {
                onDone(saveVertexSetup(draft))
              } catch (failure) {
                setError(failure instanceof Error ? failure.message : tSync('vertex.saveFailed'))
              }
            } else if (value === 'rename') {
              go('connectionName')
            } else if (value === 'project') {
              go('projects')
            } else if (value === 'location') {
              go('location')
            } else if (value === 'credentials') {
              go('credentials')
            } else {
              back()
            }
          },
        )}
      </>
    )
  }
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>{tSync('vertex.loginTitle')}</Text>
      {error && <Text color="error">{error}</Text>}
      {content}
      {!busyKey && <Text dimColor>{tSync('onboarding.confirmBack')}</Text>}
    </Box>
  )
}

function VertexSetupInput({
  label,
  initial,
  onSubmit,
  onBack,
}: {
  label: string
  initial: string
  onSubmit(value: string): void
  onBack(): void
}) {
  const value = useRef(initial)
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>{label}</Text>
      <Select
        options={[
          {
            type: 'input',
            value: 'input',
            label,
            initialValue: initial,
            onChange: (text: string) => {
              value.current = text
            },
            allowEmptySubmitToCancel: true,
          },
        ]}
        onChange={() => {
          if (value.current.trim()) {
            onSubmit(value.current.trim())
          }
        }}
        onCancel={onBack}
      />
    </Box>
  )
}
