import { peekForStdinData } from '../../utils/process.js'

/**
 * 解析无头模式（-p）下的 stdin → prompt 合并逻辑。stream-json 输入直接转发，
 * text 输入会等待至多 3 秒拉取 stdin 内容并与 prompt 串联。
 */
export async function getInputPrompt(
  prompt: string,
  inputFormat: 'text' | 'stream-json',
): Promise<string | AsyncIterable<string>> {
  if (
    !process.stdin.isTTY &&
    // 输入劫持会破坏 MCP。
    !process.argv.includes('mcp')
  ) {
    if (inputFormat === 'stream-json') {
      return process.stdin
    }
    process.stdin.setEncoding('utf8')
    let data = ''
    const onData = (chunk: string) => {
      data += chunk
    }
    process.stdin.on('data', onData)
    // 如果 3 秒内没有数据到达，停止等待并发出警告。Stdin 可能是
    // 从没有写入的父进程继承的管道（子进程生成时
    // 没有明确的 stdin 处理）。3 秒覆盖了慢速生产者如 curl、
    // 大文件上的 jq、有导入开销的 python。警告使
    // 对于仍然更慢的罕见生产者，静默数据丢失可见。
    const timedOut = await peekForStdinData(process.stdin, 3000)
    process.stdin.off('data', onData)
    if (timedOut) {
      process.stderr.write(
        'Warning: no stdin data received in 3s, proceeding without it. ' +
          'If piping from a slow command, redirect stdin explicitly: < /dev/null to skip, or wait longer.\n',
      )
    }
    return [prompt, data].filter(Boolean).join('\n')
  }
  return prompt
}
