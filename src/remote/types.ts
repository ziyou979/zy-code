/** 直连会话向服务端回复权限请求时使用的共享类型。 */

export type RemotePermissionResponse =
  | {
      behavior: 'allow'
      updatedInput: Record<string, unknown>
    }
  | {
      behavior: 'deny'
      message: string
    }
