import * as React from 'react'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { PluginSettings } from './PluginSettings.js'
export async function call(
  onDone: LocalJSXCommandOnDone,
  _context: unknown,
  args?: string,
): Promise<React.ReactNode> {
  return (
    <PluginSettings
      onComplete={onDone}
      args={args ?? ''}
      // biome-ignore lint/suspicious/noExplicitAny: 运行时动态类型处理
      showMcpRedirectMessage={undefined as any}
    />
  )
}
