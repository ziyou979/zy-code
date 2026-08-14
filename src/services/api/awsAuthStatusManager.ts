/**
 * 云 provider 认证状态（AWS Bedrock、GCP Vertex）的单例管理器。在认证工具与 React 组件或
 * SDK 输出之间传递认证刷新状态。SDK 的 auth_status 消息结构与 provider 无关，因此所有
 * provider 共用一个管理器。
 *
 * 名称为历史遗留：最初仅用于 AWS，现在用于所有云认证刷新流程。
 */

import { createSignal } from '../../utils/signal.js'

export type AwsAuthStatus = {
  isAuthenticating: boolean
  output: string[]
  error?: string
}

export class AwsAuthStatusManager {
  private static instance: AwsAuthStatusManager | null = null
  private status: AwsAuthStatus = {
    isAuthenticating: false,
    output: [],
  }
  private changed = createSignal<[status: AwsAuthStatus]>()

  static getInstance(): AwsAuthStatusManager {
    if (!AwsAuthStatusManager.instance) {
      AwsAuthStatusManager.instance = new AwsAuthStatusManager()
    }
    return AwsAuthStatusManager.instance
  }

  getStatus(): AwsAuthStatus {
    return {
      ...this.status,
      output: [...this.status.output],
    }
  }

  startAuthentication(): void {
    this.status = {
      isAuthenticating: true,
      output: [],
    }
    this.changed.emit(this.getStatus())
  }

  addOutput(line: string): void {
    this.status.output.push(line)
    this.changed.emit(this.getStatus())
  }

  setError(error: string): void {
    this.status.error = error
    this.changed.emit(this.getStatus())
  }

  endAuthentication(success: boolean): void {
    if (success) {
      // 成功时彻底清除状态
      this.status = {
        isAuthenticating: false,
        output: [],
      }
    } else {
      // 失败时保留输出以供查看
      this.status.isAuthenticating = false
    }
    this.changed.emit(this.getStatus())
  }

  subscribe = this.changed.subscribe

  // 供测试清理状态
  static reset(): void {
    if (AwsAuthStatusManager.instance) {
      AwsAuthStatusManager.instance.changed.clear()
      AwsAuthStatusManager.instance = null
    }
  }
}
