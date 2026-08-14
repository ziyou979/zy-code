/**
 * 向另一个 Zy 会话发送消息，用于会话间通信。
 * 这是外部构建使用的 stub 实现。
 */
export async function postInterZyMessage(
  _target: string,
  _message: string,
): Promise<{ ok: boolean; error?: string }> {
  // 外部构建不支持 peer session，因此 stub 始终返回失败。
  return {
    ok: false,
    error: 'inter-session messaging is not available in this build',
  }
}
