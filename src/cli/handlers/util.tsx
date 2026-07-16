/**
 * Miscellaneous subcommand handlers — extracted from main.tsx for lazy loading.
 * doctor, install
 */
/* eslint-disable custom-rules/no-process-exit -- CLI subcommand handlers intentionally exit */

import { cwd } from 'node:process'
import React from 'react'
import { useManagePlugins } from '../../hooks/useManagePlugins.js'
import type { Root } from '../../ink/index.js'
import { Box } from '../../ink/index.js'
import { KeybindingSetup } from '../../keybindings/KeybindingProviderSetup.js'
import { logEvent } from '../../services/analytics/index.js'
import { MCPConnectionManager } from '../../services/mcp/MCPConnectionManager.js'
import { AppStateProvider } from '../../state/AppState.js'
import { onChangeAppState } from '../../state/onChangeAppState.js'

// DoctorWithPlugins wrapper + doctor handler
const DoctorLazy = React.lazy(() =>
  import('../../screens/Doctor.js').then((m) => ({
    default: m.Doctor,
  })),
)
function DoctorWithPlugins({ onDone }: { onDone: () => void }) {
  useManagePlugins()
  return (
    <React.Suspense fallback={null}>
      <DoctorLazy onDone={onDone} />
    </React.Suspense>
  )
}
export async function doctorHandler(root: Root): Promise<void> {
  logEvent('zy_doctor_command', {})
  await new Promise<void>((resolve) => {
    root.render(
      <AppStateProvider>
        <KeybindingSetup>
          <MCPConnectionManager dynamicMcpConfig={undefined} isStrictMcpConfig={false}>
            <DoctorWithPlugins
              onDone={() => {
                void resolve()
              }}
            />
          </MCPConnectionManager>
        </KeybindingSetup>
      </AppStateProvider>,
    )
  })
  root.unmount()
  process.exit(0)
}

// install handler
export async function installHandler(
  target: string | undefined,
  options: {
    force?: boolean
  },
): Promise<void> {
  const { setup } = await import('../../bootstrap/setup.js')
  await setup(cwd(), 'default', false, false, undefined, false)
  const { install } = await import('../../commands/install.js')
  await new Promise<void>((resolve) => {
    const args: string[] = []
    if (target) {
      args.push(target)
    }
    if (options.force) {
      args.push('--force')
    }
    void install.call(
      (result) => {
        void resolve()
        process.exit(result.includes('failed') ? 1 : 0)
      },
      {},
      args,
    )
  })
}
