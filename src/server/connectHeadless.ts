/**
 * Headless 连接运行器。
 */
export async function runConnectHeadless(
  // biome-ignore lint/suspicious/noExplicitAny: 运行时动态类型处理
  _config: any,
  _prompt: string,
  _outputFormat: string,
  _interactive: boolean,
): Promise<void> {
  throw new Error('runConnectHeadless not implemented')
}
