/**
 * 多 Provider OAuth 类型定义
 *
 * 参考 pi 的 OAuthProviderInterface 设计，增加 apiProvider / apiFormat
 * 字段用于映射到 zy-code 的 PROVIDER_REGISTRY。
 */

import type { ApiFormat } from '../../model/apiFormat.js'

/** OAuth 凭证 — 所有 provider 通用的 token 结构 */
export type OAuthCredentials = {
  refresh: string
  access: string
  expires: number
  [key: string]: unknown
}

/** OAuth Provider ID — 字符串别名，便于扩展 */
export type OAuthProviderId = string

/** 浏览器授权信息 */
export type OAuthAuthInfo = {
  url: string
  instructions?: string
}

/** 设备码授权信息（RFC 8628） */
export type OAuthDeviceCodeInfo = {
  userCode: string
  verificationUri: string
  intervalSeconds?: number
  expiresInSeconds?: number
}

/** 文本输入提示 */
export type OAuthPrompt = {
  message: string
  placeholder?: string
  allowEmpty?: boolean
}

/** 选择器选项 */
export type OAuthSelectOption = {
  id: string
  label: string
}

/** 选择器提示 */
export type OAuthSelectPrompt = {
  message: string
  options: OAuthSelectOption[]
}

/** 登录流程中的回调集合 — UI 层实现这些回调来驱动交互 */
export interface OAuthLoginCallbacks {
  /** 浏览器授权开始时调用，传入授权 URL */
  onAuth: (info: OAuthAuthInfo) => void
  /** 设备码流程开始时调用，传入用户码和验证 URL */
  onDeviceCode: (info: OAuthDeviceCodeInfo) => void
  /** 需要用户文本输入时调用（如手动粘贴授权码） */
  onPrompt: (prompt: OAuthPrompt) => Promise<string>
  /** 可选的进度通知 */
  onProgress?: (message: string) => void
  /** 可选的手动代码输入 — 与浏览器回调竞争，先完成者生效 */
  onManualCodeInput?: () => Promise<string>
  /** 显示交互选择器并返回选中项 ID，取消返回 undefined */
  onSelect: (prompt: OAuthSelectPrompt) => Promise<string | undefined>
  /** 可选的取消信号 */
  signal?: AbortSignal
}

/** OAuth Provider 接口 — 每个 provider 独立实现 */
export interface OAuthProviderInterface {
  /** Provider 唯一标识 */
  readonly id: OAuthProviderId
  /** 显示名称 */
  readonly name: string

  /** 运行登录流程，返回需要持久化的凭证 */
  login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>

  /** 登录是否使用本地回调服务器（支持手动代码输入） */
  usesCallbackServer?: boolean

  /** 刷新过期凭证，返回更新后的凭证 */
  refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials>

  /** 将凭证转换为 API key 字符串 */
  getApiKey(credentials: OAuthCredentials): string

  /** 映射到 zy-code PROVIDER_REGISTRY 中的 provider ID */
  apiProvider?: string

  /** 映射到 zy-code 的 API 消息格式 */
  apiFormat?: ApiFormat
}
