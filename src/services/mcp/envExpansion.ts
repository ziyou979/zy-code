/**
 * 展开 MCP server 配置中环境变量的共享工具。
 */

/**
 * 展开字符串中的环境变量，支持 ${VAR} 和 ${VAR:-default} 语法。
 * @returns 包含展开后字符串及缺失变量列表的对象
 */
export function expandEnvVarsInString(value: string): {
  expanded: string
  missingVars: string[]
} {
  const missingVars: string[] = []

  const expanded = value.replace(/\$\{([^}]+)\}/g, (match, varContent) => {
    // 按 :- 拆分以支持默认值；最多拆成两段，从而保留默认值中的 :-
    const [varName, defaultValue] = varContent.split(':-', 2)
    const envValue = process.env[varName]

    if (envValue !== undefined) {
      return envValue
    }
    if (defaultValue !== undefined) {
      return defaultValue
    }

    // 记录缺失变量，供错误报告使用
    missingVars.push(varName)
    // 找不到变量时返回原值，便于调试，同时仍会报告错误
    return match
  })

  return {
    expanded,
    missingVars,
  }
}
