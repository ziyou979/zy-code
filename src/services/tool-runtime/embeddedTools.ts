import { isEnvTruthy } from '../../services/infra/envUtils.js'

export function hasEmbeddedSearchTools(): boolean {
  if (!isEnvTruthy(process.env.EMBEDDED_SEARCH_TOOLS)) {
    return false
  }
  const e = process.env.ZY_CODE_ENTRYPOINT
  return e !== 'sdk-ts' && e !== 'sdk-py' && e !== 'sdk-cli' && e !== 'local-agent'
}

export function embeddedSearchToolsBinaryPath(): string {
  return process.execPath
}
