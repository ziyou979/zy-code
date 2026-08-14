import { isEnvTruthy, isInternalBuild } from '../services/infra/envUtils.js'

// 延迟读取，以便获取模块加载后才应用的 globalSettings.env.ENABLE_GROWTHBOOK_DEV。
// USER_TYPE 是构建期 define，因此可以安全读取。
export function getGrowthBookClientKey(): string {
  return isInternalBuild()
    ? isEnvTruthy(process.env.ENABLE_GROWTHBOOK_DEV)
      ? 'sdk-yZQvlplybuXjYh6L'
      : 'sdk-xRVcrliHIlrg4og4'
    : 'sdk-zAZezfDKGoZuXXKe'
}
