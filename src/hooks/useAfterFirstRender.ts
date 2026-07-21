import { useEffect } from 'react'
import { isEnvTruthy, isInternalBuild } from '../services/infra/envUtils.js'

export function useAfterFirstRender(): void {
  useEffect(() => {
    if (isInternalBuild() && isEnvTruthy(process.env.ZY_CODE_EXIT_AFTER_FIRST_RENDER)) {
      process.stderr.write(`\nStartup time: ${Math.round(process.uptime() * 1000)}ms\n`)
      // eslint-disable-next-line custom-rules/no-process-exit
      process.exit(0)
    }
  }, [])
}
