import { join } from 'node:path'
import { Suspense, use, useEffect, useState } from 'react'
import { KeybindingWarnings } from 'src/components/KeybindingWarnings.js'
import { McpParsingWarnings } from 'src/components/mcp/McpParsingWarnings.js'
import { getModelMaxOutputTokens } from 'src/utils/context.js'
import { getZyConfigHomeDir } from 'src/utils/envUtils.js'
import type { SettingSource } from 'src/utils/settings/constants.js'
import { getOriginalCwd } from '../bootstrap/state.js'
import type { CommandResultDisplay } from '../commands.js'
import { Pane } from '../components/design-system/Pane.js'
import { PressEnterToContinue } from '../components/PressEnterToContinue.js'
import { SandboxDoctorSection } from '../components/sandbox/SandboxDoctorSection.js'
import { ValidationErrorsList } from '../components/ValidationErrorsList.js'
import { WARNING } from '../constants/figures.js'
import { useSettingsErrors } from '../hooks/notifs/useSettingsErrors.js'
import { useExitOnCtrlCDWithKeybindings } from '../hooks/useExitOnCtrlCDWithKeybindings.js'
import { tSync } from '../i18n/index.js'
import { Box, Text } from '../ink.js'
import { useKeybindings } from '../keybindings/useKeybinding.js'
import {
  cleanupStaleLocks,
  getAllLockInfo,
  isPidBasedLockingEnabled,
  type LockInfo,
} from '../services/native-installer/pidLock.js'
import {
  TASK_MAX_OUTPUT_DEFAULT,
  TASK_MAX_OUTPUT_UPPER_LIMIT,
} from '../services/task/outputFormatting.js'
import {
  BASH_MAX_OUTPUT_DEFAULT,
  BASH_MAX_OUTPUT_UPPER_LIMIT,
} from '../shell-eval/shared/outputLimits.js'
import { useAppState } from '../state/AppState.js'
import { getPluginErrorMessage } from '../types/plugin.js'
import { getGcsDistTags, getNpmDistTags, type NpmDistTags } from '../utils/autoUpdater.js'
import { type ContextWarnings, checkContextWarnings } from '../utils/doctorContextWarnings.js'
import { type DiagnosticInfo, getDoctorDiagnostic } from '../utils/doctorDiagnostic.js'
import { validateBoundedIntEnvVar } from '../utils/envValidation.js'
import { pathExists } from '../utils/file.js'
import { getInitialSettings } from '../utils/settings/settings.js'
import { getXDGStateHome } from '../utils/xdg.js'

type Props = {
  onDone: (
    result?: string,
    options?: {
      display?: CommandResultDisplay
    },
  ) => void
}
type AgentInfo = {
  activeAgents: Array<{
    agentType: string
    source: SettingSource | 'built-in' | 'plugin'
  }>
  userAgentsDir: string
  projectAgentsDir: string
  userDirExists: boolean
  projectDirExists: boolean
  failedFiles?: Array<{
    path: string
    error: string
  }>
}
type VersionLockInfo = {
  enabled: boolean
  locks: LockInfo[]
  locksDir: string
  staleLocksCleaned: number
}
type DistTagsDisplayProps = {
  promise: Promise<NpmDistTags | { latest: null; stable: null }>
}
function DistTagsDisplay({ promise }: DistTagsDisplayProps) {
  const distTags = use(promise)
  if (!distTags.latest) {
    return <Text dimColor={true}>└ {tSync('doctor.failedToFetchVersions')}</Text>
  }
  return (
    <>
      {distTags.stable && (
        <Text>
          └ {tSync('doctor.stableVersion')}: {distTags.stable}
        </Text>
      )}
      {
        <Text>
          └ {tSync('doctor.latestVersion')}: {distTags.latest}
        </Text>
      }
    </>
  )
}
export function Doctor({ onDone }: Props) {
  const agentDefinitions = useAppState((s) => s.agentDefinitions)
  const mcpTools = useAppState((state) => state.mcp.tools)
  const toolPermissionContext = useAppState((state) => state.toolPermissionContext)
  const pluginsErrors = useAppState((state) => state.plugins.errors)
  useExitOnCtrlCDWithKeybindings()
  const tools = mcpTools || []
  const [diagnostic, setDiagnostic] = useState<DiagnosticInfo | null>(null)
  const [agentInfo, setAgentInfo] = useState<AgentInfo | null>(null)
  const [contextWarnings, setContextWarnings] = useState<ContextWarnings | null>(null)
  const [versionLockInfo, setVersionLockInfo] = useState<VersionLockInfo | null>(null)
  const validationErrors = useSettingsErrors()
  const distTagsPromise = getDoctorDiagnostic().then((diag) => {
    const fetchDistTags = diag.installationType === 'native' ? getGcsDistTags : getNpmDistTags
    return fetchDistTags().catch(() => ({
      latest: null,
      stable: null,
    }))
  })
  const autoUpdatesChannel = getInitialSettings()?.autoUpdatesChannel ?? 'latest'
  const errorsExcludingMcp = validationErrors.filter(
    (error) => error.mcpErrorMetadata === undefined,
  )
  const envVars = [
    {
      name: 'BASH_MAX_OUTPUT_LENGTH',
      default: BASH_MAX_OUTPUT_DEFAULT,
      upperLimit: BASH_MAX_OUTPUT_UPPER_LIMIT,
    },
    {
      name: 'TASK_MAX_OUTPUT_LENGTH',
      default: TASK_MAX_OUTPUT_DEFAULT,
      upperLimit: TASK_MAX_OUTPUT_UPPER_LIMIT,
    },
    {
      name: 'ZY_CODE_MAX_OUTPUT_TOKENS',
      ...getModelMaxOutputTokens('qwen3.6-plus'),
    },
  ]
  const envValidationErrors = envVars
    .map((v) => {
      const value = process.env[v.name]
      const result = validateBoundedIntEnvVar(v.name, value, v.default, v.upperLimit)
      return {
        name: v.name,
        ...result,
      }
    })
    .filter((result) => result.status !== 'valid')
  useEffect(() => {
    getDoctorDiagnostic().then(setDiagnostic)
    ;(async () => {
      const userAgentsDir = join(getZyConfigHomeDir(), 'agents')
      const projectAgentsDir = join(getOriginalCwd(), '.zy', 'agents')
      const { activeAgents, allAgents, failedFiles } = agentDefinitions
      const [userDirExists, projectDirExists] = await Promise.all([
        pathExists(userAgentsDir),
        pathExists(projectAgentsDir),
      ])
      const agentInfoData = {
        activeAgents: activeAgents.map((a) => ({
          agentType: a.agentType,
          source: a.source,
        })),
        userAgentsDir,
        projectAgentsDir,
        userDirExists,
        projectDirExists,
        failedFiles,
      }
      setAgentInfo(agentInfoData)
      const warnings = await checkContextWarnings(
        tools,
        {
          activeAgents,
          allAgents,
          failedFiles,
        },
        async () => toolPermissionContext,
      )
      setContextWarnings(warnings)
      if (isPidBasedLockingEnabled()) {
        const locksDir = join(getXDGStateHome(), 'zy', 'locks')
        const staleLocksCleaned = cleanupStaleLocks(locksDir)
        const locks = getAllLockInfo(locksDir)
        setVersionLockInfo({
          enabled: true,
          locks,
          locksDir,
          staleLocksCleaned,
        })
      } else {
        setVersionLockInfo({
          enabled: false,
          locks: [],
          locksDir: '',
          staleLocksCleaned: 0,
        })
      }
    })()
  }, [toolPermissionContext, tools, agentDefinitions])
  const handleDismiss = () => {
    onDone(tSync('doctor.dismissed'), {
      display: 'system',
    })
  }
  useKeybindings(
    {
      'confirm:yes': handleDismiss,
      'confirm:no': handleDismiss,
    },
    {
      context: 'Confirmation',
    },
  )
  if (!diagnostic) {
    return (
      <Pane>
        <Text dimColor={true}>{tSync('doctor.checking')}</Text>
      </Pane>
    )
  }
  const searchStatusText = diagnostic.ripgrepStatus.working
    ? tSync('doctor.searchOk')
    : tSync('doctor.searchNotWorking')
  const autoUpdatesDisplay = diagnostic.packageManager
    ? tSync('doctor.managedByPackageManager')
    : diagnostic.autoUpdates
  const versionLocksSection = versionLockInfo?.enabled && (
    <Box flexDirection="column">
      <Text bold={true}>{tSync('doctor.versionLocks')}</Text>
      {versionLockInfo.staleLocksCleaned > 0 && (
        <Text dimColor={true}>
          └ {tSync('doctor.cleanedStaleLocks')} {versionLockInfo.staleLocksCleaned}{' '}
          {tSync('doctor.staleLocks')}
        </Text>
      )}
      {versionLockInfo.locks.length === 0 ? (
        <Text dimColor={true}>└ {tSync('doctor.noActiveLocks')}</Text>
      ) : (
        versionLockInfo.locks.map((lock, index) => (
          <Text key={index}>
            └ {lock.version}: PID {lock.pid}{' '}
            {lock.isProcessRunning ? (
              <Text>（{tSync('doctor.running')}）</Text>
            ) : (
              <Text color="warning">（{tSync('doctor.stale')}）</Text>
            )}
          </Text>
        ))
      )}
    </Box>
  )
  const agentParseErrorsSection = agentInfo?.failedFiles && agentInfo.failedFiles.length > 0 && (
    <Box flexDirection="column">
      <Text bold={true} color="error">
        {tSync('doctor.agentParseErrors')}
      </Text>
      <Text color="error">
        └ {tSync('doctor.failedToParse')} {agentInfo.failedFiles.length}{' '}
        {tSync('doctor.agentFiles')}:
      </Text>
      {agentInfo.failedFiles.map((file, i_3) => (
        <Text key={i_3} dimColor={true}>
          {'  '}└ {file.path}: {file.error}
        </Text>
      ))}
    </Box>
  )
  const unreachableRulesSection = contextWarnings?.unreachableRulesWarning && (
    <Box flexDirection="column">
      <Text bold={true} color="warning">
        {tSync('doctor.unreachableRules')}
      </Text>
      <Text>
        └{' '}
        <Text color="warning">
          {WARNING} {contextWarnings.unreachableRulesWarning.message}
        </Text>
      </Text>
      {contextWarnings.unreachableRulesWarning.details.map((detail, i_5) => (
        <Text key={i_5} dimColor={true}>
          {'  '}└ {detail}
        </Text>
      ))}
    </Box>
  )
  return (
    <Pane>
      {
        <Box flexDirection="column">
          {<Text bold={true}>{tSync('doctor.title')}</Text>}
          {
            <Text>
              └ {tSync('doctor.currentlyRunning')} {diagnostic.installationType} (
              {diagnostic.version})
            </Text>
          }
          {diagnostic.packageManager && (
            <Text>
              └ {tSync('doctor.packageManager')} {diagnostic.packageManager}
            </Text>
          )}
          {
            <Text>
              └ {tSync('doctor.path')}: {diagnostic.installationPath}
            </Text>
          }
          {
            <Text>
              └ {tSync('doctor.invoked')}: {diagnostic.invokedBinary}
            </Text>
          }
          {
            <Text>
              └ {tSync('doctor.configInstallMethod')}: {diagnostic.configInstallMethod}
            </Text>
          }
          {
            <Text>
              └ {tSync('doctor.searchLabel')}: {searchStatusText} ({diagnostic.ripgrepStatus.path})
            </Text>
          }
          {
            <Text>
              └ {tSync('doctor.permissionMode')}: {toolPermissionContext.mode}
            </Text>
          }
          {diagnostic.recommendation && (
            <>
              <Text />
              <Text color="warning">
                {tSync('doctor.recommendation')}: {diagnostic.recommendation.split('\n')[0]}
              </Text>
              <Text dimColor={true}>{diagnostic.recommendation.split('\n')[1]}</Text>
            </>
          )}
          {diagnostic.multipleInstallations.length > 1 && (
            <>
              <Text />
              <Text color="warning">{tSync('doctor.warningMultipleInstallations')}</Text>
              {diagnostic.multipleInstallations.map((install, i) => (
                <Text key={i}>
                  └ {install.type} at {install.path}
                </Text>
              ))}
            </>
          )}
          {diagnostic.warnings.length > 0 && (
            <>
              <Text />
              {diagnostic.warnings.map((warning, i_0) => (
                <Box key={i_0} flexDirection="column">
                  <Text color="warning">
                    {tSync('doctor.warning')} {warning.issue}
                  </Text>
                  <Text>
                    {tSync('doctor.fix')} {warning.fix}
                  </Text>
                </Box>
              ))}
            </>
          )}
          {errorsExcludingMcp.length > 0 && (
            <Box flexDirection="column" marginTop={1} marginBottom={1}>
              <Text bold={true}>{tSync('doctor.invalidSettings')}</Text>
              <ValidationErrorsList errors={errorsExcludingMcp} />
            </Box>
          )}
        </Box>
      }
      {
        <Box flexDirection="column">
          {<Text bold={true}>{tSync('doctor.updates')}</Text>}
          {
            <Text>
              └ {tSync('doctor.autoUpdates')}: {autoUpdatesDisplay}
            </Text>
          }
          {diagnostic.hasUpdatePermissions !== null && (
            <Text>
              └ {tSync('doctor.updatePermissions')}:{' '}
              {diagnostic.hasUpdatePermissions
                ? tSync('doctor.yes')
                : tSync('doctor.noRequiresSudo')}
            </Text>
          )}
          {
            <Text>
              └ {tSync('doctor.autoUpdateChannel')}: {autoUpdatesChannel}
            </Text>
          }
          {
            <Suspense fallback={null}>
              <DistTagsDisplay promise={distTagsPromise} />
            </Suspense>
          }
        </Box>
      }
      {<SandboxDoctorSection />}
      {<McpParsingWarnings />}
      {<KeybindingWarnings />}
      {envValidationErrors.length > 0 && (
        <Box flexDirection="column">
          <Text bold={true}>{tSync('doctor.environmentVariables')}</Text>
          {envValidationErrors.map((validation, i_1) => (
            <Text key={i_1}>
              └ {validation.name}:{' '}
              <Text color={validation.status === 'capped' ? 'warning' : 'error'}>
                {validation.message}
              </Text>
            </Text>
          ))}
        </Box>
      )}
      {versionLocksSection}
      {agentParseErrorsSection}
      {pluginsErrors.length > 0 && (
        <Box flexDirection="column">
          <Text bold={true} color="error">
            {tSync('doctor.pluginErrors')}
          </Text>
          <Text color="error">
            └ {tSync('doctor.pluginErrorsDetected')} {pluginsErrors.length}{' '}
            {tSync('doctor.pluginErrorCount')}:
          </Text>
          {pluginsErrors.map((error_0, i_4) => (
            <Text key={i_4} dimColor={true}>
              {'  '}└ {error_0.source || tSync('doctor.unknownSource')}
              {'plugin' in error_0 && error_0.plugin ? ` [${error_0.plugin}]` : ''}:{' '}
              {getPluginErrorMessage(error_0)}
            </Text>
          ))}
        </Box>
      )}
      {unreachableRulesSection}
      {contextWarnings &&
        (contextWarnings.agentsMdWarning ||
          contextWarnings.agentWarning ||
          contextWarnings.mcpWarning) && (
          <Box flexDirection="column">
            <Text bold={true}>{tSync('doctor.contextWarnings')}</Text>
            {contextWarnings.agentsMdWarning && (
              <>
                <Text>
                  └{' '}
                  <Text color="warning">
                    {WARNING} {contextWarnings.agentsMdWarning.message}
                  </Text>
                </Text>
                <Text>
                  {'  '}└ {tSync('status.cwd')}:
                </Text>
                {contextWarnings.agentsMdWarning.details.map((detail_0, i_6) => (
                  <Text key={i_6} dimColor={true}>
                    {'    '}└ {detail_0}
                  </Text>
                ))}
              </>
            )}
            {contextWarnings.agentWarning && (
              <>
                <Text>
                  └{' '}
                  <Text color="warning">
                    {WARNING} {contextWarnings.agentWarning.message}
                  </Text>
                </Text>
                <Text>
                  {'  '}└ {tSync('doctor.topContributors')}
                </Text>
                {contextWarnings.agentWarning.details.map((detail_1, i_7) => (
                  <Text key={i_7} dimColor={true}>
                    {'    '}└ {detail_1}
                  </Text>
                ))}
              </>
            )}
            {contextWarnings.mcpWarning && (
              <>
                <Text>
                  └{' '}
                  <Text color="warning">
                    {WARNING} {contextWarnings.mcpWarning.message}
                  </Text>
                </Text>
                <Text>
                  {'  '}└ {tSync('doctor.mcpServers')}
                </Text>
                {contextWarnings.mcpWarning.details.map((detail_2, i_8) => (
                  <Text key={i_8} dimColor={true}>
                    {'    '}└ {detail_2}
                  </Text>
                ))}
              </>
            )}
          </Box>
        )}
      {
        <Box>
          <PressEnterToContinue />
        </Box>
      }
    </Pane>
  )
}
