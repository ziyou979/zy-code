/**
 * PKCE (Proof Key for Code Exchange) 工具
 *
 * 使用 Web Crypto API 实现，兼容 Node.js 20+ 和 Bun。
 */

/** 将字节数组编码为 base64url 字符串 */
function base64urlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

/** 生成 PKCE code verifier 和 code challenge（S256） */
export async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  // 生成随机 verifier
  const verifierBytes = new Uint8Array(32)
  crypto.getRandomValues(verifierBytes)
  const verifier = base64urlEncode(verifierBytes)

  // 计算 SHA-256 challenge
  const encoder = new TextEncoder()
  const data = encoder.encode(verifier)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const challenge = base64urlEncode(new Uint8Array(hashBuffer))

  return { verifier, challenge }
}
