import { isEnvTruthy } from '../../utils/envUtils.js'
/**
 * 根据 argv / 环境变量初始化 ZY_CODE_ENTRYPOINT 环境变量。
 * 已被外部设置（SDK / 其它入口）时直接返回。
 */
export function initializeEntrypoint(isNonInteractive: boolean): void {
  // 如果已设置则跳过（例如由 SDK 或其他入口点设置）
  if (process.env.ZY_CODE_ENTRYPOINT) {
    return
  }
  const cliArgs = process.argv.slice(2)

  // 检查 MCP serve 命令（处理 mcp serve 前的标志，例如 --debug mcp serve）
  const mcpIndex = cliArgs.indexOf('mcp')
  if (mcpIndex !== -1 && cliArgs[mcpIndex + 1] === 'serve') {
    process.env.ZY_CODE_ENTRYPOINT = 'mcp'
    return
  }
  if (isEnvTruthy(process.env.ZY_CODE_ACTION)) {
    process.env.ZY_CODE_ENTRYPOINT = 'zy-code-github-action'
    return
  }

  // 注意：'local-agent' 入口点由本地代理模式启动器
  // 通过 ZY_CODE_ENTRYPOINT 环境变量设置（由上方的提前返回处理）

  // 根据交互状态设置
  process.env.ZY_CODE_ENTRYPOINT = isNonInteractive ? 'sdk-cli' : 'cli'
}
