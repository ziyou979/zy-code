import React from 'react'
import { Box, render, Text } from '../ink.js'
import { tSync } from '../i18n/index.js'
import { KeybindingSetup } from '../keybindings/KeybindingProviderSetup.js'
import { AppStateProvider } from '../state/AppState.js'
import type { ConfigParseError } from '../utils/errors.js'
import { getBaseRenderOptions } from '../utils/renderOptions.js'
import { jsonStringify, writeFileSync_DEPRECATED } from '../utils/slowOperations.js'
import type { ThemeName } from '../utils/theme.js'
import { Select } from './CustomSelect/index.js'
import { Dialog } from './design-system/Dialog.js'
interface InvalidConfigHandlerProps {
  error: ConfigParseError
}
interface InvalidConfigDialogProps {
  filePath: string
  errorDescription: string
  onExit: () => void
  onReset: () => void
}

/**
 * Dialog shown when the Zy config file contains invalid JSON
 */
function InvalidConfigDialog({
  filePath,
  errorDescription,
  onExit,
  onReset,
}: InvalidConfigDialogProps) {
  const handleSelect = (value) => {
    if (value === 'exit') {
      onExit()
    } else {
      onReset()
    }
  }
  return (
    <Dialog title={tSync('invalidConfig.title')} color="error" onCancel={onExit}>
      {
        <Box flexDirection="column" gap={1}>
          {<Text>{tSync('invalidConfig.body', { filePath })}</Text>}
          {<Text>{errorDescription}</Text>}
        </Box>
      }
      {
        <Box flexDirection="column">
          {<Text bold={true}>{tSync('invalidConfig.prompt')}</Text>}
          <Select
            options={[
              {
                label: tSync('invalidConfig.exit'),
                value: 'exit',
              },
              {
                label: tSync('invalidConfig.reset'),
                value: 'reset',
              },
            ]}
            onChange={handleSelect}
            onCancel={onExit}
          />
        </Box>
      }
    </Dialog>
  )
}

/**
 * Safe fallback theme name for error dialogs to avoid circular dependency.
 * Uses a hardcoded dark theme that doesn't require reading from config.
 */
const SAFE_ERROR_THEME_NAME: ThemeName = 'dark'
export async function showInvalidConfigDialog({ error }: InvalidConfigHandlerProps): Promise<void> {
  // 为特定用途扩展 RenderOptions，添加 theme 属性
  type SafeRenderOptions = Parameters<typeof render>[1] & {
    theme?: ThemeName
  }
  const renderOptions: SafeRenderOptions = {
    ...getBaseRenderOptions(false),
    // 重要：使用硬编码的主题名称以避免与 getGlobalConfig() 的循环依赖
    // 这使错误对话框即使在配置文件有 JSON 语法错误时也能显示
    theme: SAFE_ERROR_THEME_NAME,
  }
  await new Promise<void>(async (resolve) => {
    const { unmount } = await render(
      <AppStateProvider>
        <KeybindingSetup>
          <InvalidConfigDialog
            filePath={error.filePath}
            errorDescription={error.message}
            onExit={() => {
              unmount()
              void resolve()
              process.exit(1)
            }}
            onReset={() => {
              writeFileSync_DEPRECATED(
                error.filePath,
                jsonStringify(error.defaultConfig, null, 2),
                {
                  flush: false,
                  encoding: 'utf8',
                },
              )
              unmount()
              void resolve()
              process.exit(0)
            }}
          />
        </KeybindingSetup>
      </AppStateProvider>,
      renderOptions,
    )
  })
}
