/**
 * 从任意文本中抹掉常见凭据（API key、Bearer token、云厂商密钥、*_TOKEN=... 等）。
 *
 * 用于 /feedback 生成的 GitHub issue 预填内容：标题、描述、近期报错在拼进 URL
 * 或交给 `gh issue create` 之前都必须先过一遍。纯函数，无 IO。
 */
export function redactSensitiveInfo(text: string): string {
  let redacted = text

  // 请求头规则放最前：先整体替换 Authorization / x-api-key 的值，
  // 避免后面的 token 规则先改写值、导致 Bearer 前缀被当成值。
  // x-api-key 头
  redacted = redacted.replace(
    /(["']?x-api-key["']?\s*[:=]\s*["']?)(?!\[REDACTED)[^"',\s)}\]]+/gi,
    '$1[REDACTED_API_KEY]',
  )

  // Authorization 头与 Bearer token
  redacted = redacted.replace(
    /(["']?authorization["']?\s*[:=]\s*["']?(bearer\s+)?)(?!\[REDACTED)[^"',\s)}\]]+/gi,
    '$1[REDACTED_TOKEN]',
  )

  // Anthropic 风格 key（sk-ant...），先处理带引号的，再处理裸露的
  redacted = redacted.replace(/"(sk-ant[^\s"']{24,})"/g, '"[REDACTED_API_KEY]"')
  redacted = redacted.replace(
    /(?<![A-Za-z0-9"'])(sk-ant-?[A-Za-z0-9_-]{10,})(?![A-Za-z0-9"'])/g,
    '[REDACTED_API_KEY]',
  )

  // OpenAI 风格 key（sk-... / sk-proj-...）
  redacted = redacted.replace(
    /(?<![A-Za-z0-9_-])(sk-(?:proj-)?[A-Za-z0-9_-]{20,})(?![A-Za-z0-9_-])/g,
    '[REDACTED_API_KEY]',
  )

  // GitHub token（ghp_ / gho_ / ghu_ / ghs_ / ghr_ / github_pat_）
  redacted = redacted.replace(
    /(?<![A-Za-z0-9_])((?:gh[pousr]_[A-Za-z0-9]{20,})|(?:github_pat_[A-Za-z0-9_]{20,}))/g,
    '[REDACTED_GITHUB_TOKEN]',
  )

  // AWS key：AWSXXXX 形式与 AKIAXXX 形式
  redacted = redacted.replace(/AWS key: "(AWS[A-Z0-9]{20,})"/g, 'AWS key: "[REDACTED_AWS_KEY]"')
  redacted = redacted.replace(/(AKIA[A-Z0-9]{16})/g, '[REDACTED_AWS_KEY]')

  // Google Cloud key
  redacted = redacted.replace(
    /(?<![A-Za-z0-9])(AIza[A-Za-z0-9_-]{35})(?![A-Za-z0-9])/g,
    '[REDACTED_GCP_KEY]',
  )

  // Vertex AI service account
  redacted = redacted.replace(
    /(?<![A-Za-z0-9])([a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com)(?![A-Za-z0-9])/g,
    '[REDACTED_GCP_SERVICE_ACCOUNT]',
  )

  // AWS_* / GOOGLE_* 环境变量
  redacted = redacted.replace(
    /(AWS[_-][A-Za-z0-9_]+\s*[=:]\s*)(?!\[REDACTED)["']?[^"',\s)}\]]+["']?/gi,
    '$1[REDACTED_AWS_VALUE]',
  )
  redacted = redacted.replace(
    /(GOOGLE[_-][A-Za-z0-9_]+\s*[=:]\s*)(?!\[REDACTED)["']?[^"',\s)}\]]+["']?/gi,
    '$1[REDACTED_GCP_VALUE]',
  )

  // 名字里带 API_KEY / TOKEN / SECRET / PASSWORD 的赋值
  // （各赋值规则都跳过已被前面规则替换成 [REDACTED_*] 的值，避免留下多余的 ]）
  redacted = redacted.replace(
    /((API[-_]?KEY|TOKEN|SECRET|PASSWORD)\s*[=:]\s*)(?!\[REDACTED)["']?[^"',\s)}\]]+["']?/gi,
    '$1[REDACTED]',
  )
  return redacted
}
