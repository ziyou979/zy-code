import { Box, Text } from '../../ink.js'
import type { SandboxDependencyCheck } from '../../services/sandbox/sandbox-adapter.js'
import { getPlatform } from '../../services/shell/platform.js'

type Props = {
  depCheck: SandboxDependencyCheck
}
export function SandboxDependenciesTab({ depCheck }: Props) {
  const platform = getPlatform()
  const isMac = platform === 'macos'
  const rgMissing = depCheck.errors.some((e) => e.includes('ripgrep'))
  const bwrapMissing = depCheck.errors.some((e_0) => e_0.includes('bwrap'))
  const socatMissing = depCheck.errors.some((e_1) => e_1.includes('socat'))
  const seccompMissing = depCheck.warnings.length > 0
  const otherErrors = depCheck.errors.filter(
    (e_2) => !e_2.includes('ripgrep') && !e_2.includes('bwrap') && !e_2.includes('socat'),
  )
  const rgInstallHint = isMac ? 'brew install ripgrep' : 'apt install ripgrep'
  return (
    <Box flexDirection="column" paddingY={1} gap={1}>
      {isMac && (
        <Box flexDirection="column">
          <Text>
            seatbelt: <Text color="success">built-in (macOS)</Text>
          </Text>
        </Box>
      )}
      {
        <Box flexDirection="column">
          {
            <Text>
              ripgrep (rg):{' '}
              {rgMissing ? (
                <Text color="error">not found</Text>
              ) : (
                <Text color="success">found</Text>
              )}
            </Text>
          }
          {rgMissing && (
            <Text dimColor={true}>
              {'  '}· {rgInstallHint}
            </Text>
          )}
        </Box>
      }
      {!isMac && (
        <>
          <Box flexDirection="column">
            <Text>
              bubblewrap (bwrap):{' '}
              {bwrapMissing ? (
                <Text color="error">not installed</Text>
              ) : (
                <Text color="success">installed</Text>
              )}
            </Text>
            {bwrapMissing && <Text dimColor={true}>{'  '}· apt install bubblewrap</Text>}
          </Box>
          <Box flexDirection="column">
            <Text>
              socat:{' '}
              {socatMissing ? (
                <Text color="error">not installed</Text>
              ) : (
                <Text color="success">installed</Text>
              )}
            </Text>
            {socatMissing && <Text dimColor={true}>{'  '}· apt install socat</Text>}
          </Box>
          <Box flexDirection="column">
            <Text>
              seccomp filter:{' '}
              {seccompMissing ? (
                <Text color="warning">not installed</Text>
              ) : (
                <Text color="success">installed</Text>
              )}
              {seccompMissing && (
                <Text dimColor={true}> (required to block unix domain sockets)</Text>
              )}
            </Text>
            {seccompMissing && (
              <Box flexDirection="column">
                <Text dimColor={true}>{'  '}· npm install -g @anthropic-ai/sandbox-runtime</Text>
                <Text dimColor={true}>
                  {'  '}· or copy vendor/seccomp/* from sandbox-runtime and set
                </Text>
                <Text dimColor={true}>
                  {'    '}sandbox.seccomp.bpfPath and applyPath in settings.json
                </Text>
              </Box>
            )}
          </Box>
        </>
      )}
      {otherErrors.map((err) => (
        <Text key={err} color="error">
          {err}
        </Text>
      ))}
    </Box>
  )
}
