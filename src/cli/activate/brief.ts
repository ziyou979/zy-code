import { feature } from 'bun:bundle'
import { setUserMsgOptIn } from 'src/bootstrap/runtime/runtimeContext.js'
import {
  type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  logEvent,
} from '../../services/analytics/index.js'
import { isEnvTruthy } from '../../services/infra/envUtils.js'
/**
 * 处理 `--brief` flag / ZY_CODE_BRIEF env：检查 KAIROS / KAIROS_BRIEF 授权后，
 * 设置 userMsgOptIn 并上报 zy_brief_mode_enabled 事件。
 */
export function maybeActivateBrief(options: unknown): void {
  if (!(feature('KAIROS') || feature('KAIROS_BRIEF'))) {
    return
  }
  const briefFlag = (
    options as {
      brief?: boolean
    }
  ).brief
  const briefEnv = isEnvTruthy(process.env.ZY_CODE_BRIEF)
  if (!briefFlag && !briefEnv) {
    return
  }
  // --brief / ZY_CODE_BRIEF 是显式选择加入：检查授权，
  // 然后设置 userMsgOptIn 以激活工具 + 提示部分。env
  // 变量也授予授权（isBriefEntitled() 读取它），所以设置
  // ZY_CODE_BRIEF=1  alone 为开发/测试强制启用 —— 不需要 GB 门
  //。initialIsBriefOnly 直接读取 getUserMsgOptIn()。
  // 条件导入：静态导入会将工具名称字符串泄漏到
  // 外部构建中，通过 BriefTool.ts → prompt.ts。
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { isBriefEntitled } =
    require('../../tools/BriefTool/BriefTool.js') as typeof import('../../tools/BriefTool/BriefTool.js')
  /* eslint-enable @typescript-eslint/no-require-imports */
  const entitled = isBriefEntitled()
  if (entitled) {
    setUserMsgOptIn(true)
  }
  // 一旦看到意图就无条件触发：enabled=false 在 Datadog 中捕获
  // "用户尝试但被门控"的失败模式。
  logEvent('zy_brief_mode_enabled', {
    enabled: entitled,
    gated: !entitled,
    source: (briefEnv
      ? 'env'
      : 'flag') as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  })
}
