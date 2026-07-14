import { checkIsGitClean, checkNeedsZyAiLogin } from '../background/remote/preconditions.js'

export type TeleportLocalErrorType = 'needsLogin' | 'needsGitStash'

/** 返回远程迁移前必须由用户处理的本地状态。 */
export async function getTeleportErrors(): Promise<Set<TeleportLocalErrorType>> {
  const errors = new Set<TeleportLocalErrorType>()
  const [needsLogin, isGitClean] = await Promise.all([checkNeedsZyAiLogin(), checkIsGitClean()])
  if (needsLogin) errors.add('needsLogin')
  if (!isGitClean) errors.add('needsGitStash')
  return errors
}
