import type { TranslationResource } from '../resourceTypes.js'

/** 报错路径的文案（说明见 en/errors.ts）。上游 API 返回的原始错误正文经 {detail} 原样带出。 */
export const zhErrors: TranslationResource = {
  'apiError.authFailed.interactive': '请运行 /login · API 错误：{detail}',
  'apiError.authFailed.nonInteractive': '认证失败。API 错误：{detail}',
  'apiError.autoModeUnavailable': '你的套餐不支持自动模式',
  'apiError.ccrAuth': '认证错误 · 可能是临时网络问题，请重试',
  'apiError.contextLimitReached': '已达到上下文上限 · 使用 /compact 或 /clear 后继续',
  'apiError.contextWindowExceeded': 'API 错误：模型已达到上下文窗口上限。',
  'apiError.creditBalanceTooLow': '余额不足',
  'apiError.creditBalanceTooLowHint': '余额不足 · 充值：https://platform.zy.com/settings/billing',
  'apiError.customOffSwitch': '当前模型请求量较高。请使用 /model 切换到其他模型。',
  'apiError.duplicateToolUseId': 'API 错误：400，对话历史中存在重复的 tool_use ID。',
  'apiError.duplicateToolUseId.withRewind':
    'API 错误：400，对话历史中存在重复的 tool_use ID。运行 /rewind 恢复对话。',
  'apiError.extraUsageRequired.interactive':
    'API 错误：1M 上下文需要额外用量 · 运行 /extra-usage 开启，或用 /model 切换到标准上下文',
  'apiError.extraUsageRequired.nonInteractive':
    'API 错误：1M 上下文需要额外用量 · 请在 zy.ai/settings/usage 开启额外用量，或用 --model 切换到标准上下文',
  'apiError.generic': 'API 错误：{detail}',
  'apiError.imageTooLarge.interactive': '图片过大。连按两次 Esc 返回，换一张更小的图片重试。',
  'apiError.imageTooLarge.nonInteractive': '图片过大。请缩小图片或换一种方式。',
  'apiError.invalidApiKeyExternal': 'API 密钥无效 · 请修正外部配置的 API 密钥',
  'apiError.keychainLockedHint': '· 请在另一个终端运行：security unlock-keychain',
  'apiError.manyImageDimensions.interactive':
    '对话中有图片超出多图请求的尺寸上限（2000px）。运行 /compact 从上下文中移除旧图片，或开启新会话。',
  'apiError.manyImageDimensions.nonInteractive':
    '对话中有图片超出多图请求的尺寸上限（2000px）。请用更少的图片开启新会话。',
  'apiError.maxOutputTokens':
    'API 错误：Zy 的回复超出了 {max} 个输出 token 的上限。可通过环境变量 ZY_CODE_MAX_OUTPUT_TOKENS 调整。',
  'apiError.modelNotFound':
    '所选模型（{model}）有问题：可能不存在，或你没有访问权限。运行 {switchCmd} 选择其他模型。',
  'apiError.notLoggedIn': '未登录 · 请运行 /login',
  'apiError.oauthOrgNotAllowed': '你的账户无权使用 ZY Code。请运行 /login。',
  'apiError.oauthOrgNotAllowedNonInteractive': '你的组织无权使用 ZY。请重新登录或联系管理员。',
  'apiError.orgDisabledEnvKey': '你的 API 密钥所属的组织已被停用 · 请更新或取消设置该环境变量',
  'apiError.orgDisabledEnvKeyWithOAuth':
    '你的 API 密钥所属的组织已被停用 · 取消设置该环境变量即可改用你的订阅',
  'apiError.pdfInvalid.interactive': 'PDF 文件无效。连按两次 Esc 返回，换一个文件重试。',
  'apiError.pdfInvalid.nonInteractive': 'PDF 文件无效。请先转换成文本（例如用 pdftotext）。',
  'apiError.pdfPasswordProtected.interactive': 'PDF 受密码保护。请连按两次 Esc 编辑消息后重试。',
  'apiError.pdfPasswordProtected.nonInteractive': 'PDF 受密码保护。请用命令行工具提取或转换该 PDF。',
  'apiError.pdfTooLarge.interactive':
    'PDF 过大（最多 {pages} 页、{size}）。连按两次 Esc 返回重试，或先用 pdftotext 转成文本。',
  'apiError.pdfTooLarge.nonInteractive':
    'PDF 过大（最多 {pages} 页、{size}）。请换一种方式读取该文件（例如用 pdftotext 提取文本）。',
  'apiError.promptTooLong': '提示词过长',
  'apiError.refusal.interactive':
    'API 错误：该请求似乎违反了使用政策，ZY Code 无法回应。请连按两次 Esc 编辑上一条消息，或开启新会话让 ZY Code 协助其他任务。',
  'apiError.refusal.nonInteractive':
    'API 错误：该请求似乎违反了使用政策，ZY Code 无法回应。请换个说法或换一种做法。',
  'apiError.repeated529': '连续多次收到 529 过载错误',
  'apiError.requestRejected429': 'API 错误：请求被拒绝（429）· {detail}',
  'apiError.requestTooLarge.interactive':
    '请求过大（最大 {size}）。连按两次 Esc 返回，换一个更小的文件重试。',
  'apiError.requestTooLarge.nonInteractive': '请求过大（最大 {size}）。请换一个更小的文件。',
  'apiError.retrying_one': '{seconds} 秒后重试…（第 {attempt}/{max} 次）',
  'apiError.retrying_other': '{seconds} 秒后重试…（第 {attempt}/{max} 次）',
  'apiError.retryTimeoutHint': ' · API_TIMEOUT_MS={ms}ms，可尝试调大',
  'apiError.timeout': '请求超时',
  'apiError.timeoutHint': '（API_TIMEOUT_MS={ms}ms，可尝试调大）',
  'apiError.tokenRevoked': 'OAuth 令牌已被撤销 · 请运行 /login',
  'apiError.tokenRevokedNonInteractive': '你的账户无权使用 ZY。请重新登录或联系管理员。',
  'apiError.toolUseConcurrency': 'API 错误：400，工具调用存在并发问题。',
  'apiError.toolUseConcurrency.withRewind': 'API 错误：400，工具调用存在并发问题。运行 /rewind 恢复对话。',
  'apiError.waitAndRetry': 'API 错误：请稍候片刻再试。',
  'print.executionError': '执行出错',
  'print.maxBudget': '错误：已超出美元预算（{budget}）',
  'print.maxTurns': '错误：已达到最大轮数（{maxTurns}）',
  'print.structuredOutputRetries': '错误：重试次数已用尽，仍未给出有效的结构化输出',
}
