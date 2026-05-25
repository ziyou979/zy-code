import figures from 'figures'
import * as React from 'react'
import { useCallback, useMemo, useState } from 'react'
import { Select } from '../../components/CustomSelect/select.js'
import { Pane } from '../../components/design-system/Pane.js'
import {
  renderStatusbarSegments,
  type Segment,
  type StatusbarContext,
} from '../../components/statusbar/renderSegments.js'
import {
  COLOR_TOKENS,
  DEFAULT_MODULES,
  effectiveColor,
  effectiveIcon,
  ICON_LIBRARY,
  mergeWithDefaults,
  type ModuleConfig,
  type ModuleId,
} from '../../components/statusbar/statusbarModuleDefaults.js'
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js'
import { useSettings } from '../../hooks/useSettings.js'
import { tSync } from '../../i18n/index.js'
import { Box, Text, useInput } from '../../ink.js'
import { useAppState } from '../../state/AppState.js'
import { resolveThemeSetting } from '../../utils/systemTheme.js'
import { getTheme, type Theme } from '../../utils/theme.js'
import { getGlobalConfig } from '../../utils/config.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'

type Mode = 'main' | 'icon' | 'color'

type Props = {
  initial: readonly ModuleConfig[]
  onSave: (modules: ModuleConfig[]) => void
  onCancel: () => void
}

/**
 * Interactive `/statusline` configuration dialog.
 *
 * Shows a live preview of the configured status bar at the top, then a
 * selectable list of modules below. Each row can be toggled (visible/hidden),
 * have its icon or color overridden, and be reordered. Changes are staged
 * locally — only persisted when the user presses Enter.
 */
export function StatuslineConfigDialog({ initial, onSave, onCancel }: Props): React.ReactNode {
  const [modules, setModules] = useState<ModuleConfig[]>(() => initial.map((m) => ({ ...m })))
  const [focusedId, setFocusedId] = useState<ModuleId>(initial[0]?.id ?? 'directory')
  const [mode, setMode] = useState<Mode>('main')

  const focusedIndex = modules.findIndex((m) => m.id === focusedId)

  // ─── Mutators (staged state only) ─────────────────────────────────────
  const toggleVisible = useCallback(() => {
    setModules((prev) =>
      prev.map((m) => (m.id === focusedId ? { ...m, visible: !m.visible } : m)),
    )
  }, [focusedId])

  const moveFocused = useCallback(
    (direction: -1 | 1) => {
      setModules((prev) => {
        const idx = prev.findIndex((m) => m.id === focusedId)
        const target = idx + direction
        if (idx < 0 || target < 0 || target >= prev.length) {
          return prev
        }
        const next = prev.slice()
        ;[next[idx], next[target]] = [next[target]!, next[idx]!]
        return next
      })
    },
    [focusedId],
  )

  const resetFocused = useCallback(() => {
    setModules((prev) =>
      prev.map((m) => {
        if (m.id !== focusedId) {
          return m
        }
        const def = DEFAULT_MODULES.find((d) => d.id === m.id)
        return def ? { ...def } : m
      }),
    )
  }, [focusedId])

  const setIcon = useCallback(
    (icon: string) => {
      setModules((prev) =>
        prev.map((m) => (m.id === focusedId ? { ...m, icon } : m)),
      )
      setMode('main')
    },
    [focusedId],
  )

  const setColor = useCallback(
    (color: string) => {
      setModules((prev) =>
        prev.map((m) => (m.id === focusedId ? { ...m, color } : m)),
      )
      setMode('main')
    },
    [focusedId],
  )

  // ─── Custom keybindings (only active on main view) ────────────────────
  useInput(
    (input, key) => {
      if (mode !== 'main') {
        return
      }
      if (key.return) {
        onSave(modules)
        return
      }
      if (key.escape) {
        onCancel()
        return
      }
      if (input === ' ') {
        toggleVisible()
        return
      }
      if (input === 'i') {
        setMode('icon')
        return
      }
      if (input === 'c') {
        setMode('color')
        return
      }
      if (input === 'r') {
        resetFocused()
        return
      }
      if (input === 'J' || (key.shift && key.downArrow)) {
        moveFocused(1)
        return
      }
      if (input === 'K' || (key.shift && key.upArrow)) {
        moveFocused(-1)
        return
      }
    },
    { isActive: mode === 'main' },
  )

  // ─── Render ────────────────────────────────────────────────────────────
  return (
    <Pane color="permission">
      <Box flexDirection="column" gap={1}>
        <Text color="remember" bold>
          {tSync('statusline.dialog.title')}
        </Text>

        <StatusbarPreview modules={modules} />

        {mode === 'main' && (
          <MainView
            modules={modules}
            focusedId={focusedId}
            onFocusChange={setFocusedId}
            onCancel={onCancel}
          />
        )}
        {mode === 'icon' && focusedIndex >= 0 && (
          <IconPickerView
            module={modules[focusedIndex]!}
            onPick={setIcon}
            onCancel={() => setMode('main')}
          />
        )}
        {mode === 'color' && focusedIndex >= 0 && (
          <ColorPickerView
            module={modules[focusedIndex]!}
            onPick={setColor}
            onCancel={() => setMode('main')}
          />
        )}
      </Box>
    </Pane>
  )
}

// ─── Sub-components ────────────────────────────────────────────────────────

function StatusbarPreview({ modules }: { modules: readonly ModuleConfig[] }): React.ReactNode {
  const mainLoopModel = useMainLoopModel()
  const effortValue = useAppState((s) => s.effortValue)
  const thinkingEnabled = useAppState((s) => s.thinkingEnabled)
  const theme = getTheme(resolveThemeSetting(getGlobalConfig().theme))

  // Preview uses mock-but-plausible context values so users can see the
  // effect of icon/color/order changes without depending on live REPL state.
  const ctx: StatusbarContext = {
    messages: [],
    mainLoopModel,
    effortValue,
    thinkingEnabled,
    branch: 'main',
    gitClean: true,
    memoryRss: 312 * 1024 * 1024,
  }
  const segments: Segment[] = renderStatusbarSegments(modules, ctx)

  return (
    <Box flexDirection="column">
      <Text dimColor>{tSync('statusline.dialog.previewLabel')}</Text>
      <Box>
        <Text wrap="truncate">
          {segments.length === 0 ? (
            <Text dimColor>{tSync('statusline.dialog.previewEmpty')}</Text>
          ) : (
            segments.map((seg, i) => (
              <React.Fragment key={i}>
                {i > 0 && <Text dimColor> │ </Text>}
                <Text color={resolveColor(theme, seg.colorToken) as never}>{seg.text}</Text>
              </React.Fragment>
            ))
          )}
        </Text>
      </Box>
    </Box>
  )
}

function MainView({
  modules,
  focusedId,
  onFocusChange,
  onCancel,
}: {
  modules: readonly ModuleConfig[]
  focusedId: ModuleId
  onFocusChange: (id: ModuleId) => void
  onCancel: () => void
}): React.ReactNode {
  const theme = getTheme(resolveThemeSetting(getGlobalConfig().theme))
  const options = useMemo(
    () =>
      modules.map((m) => ({
        value: m.id,
        label: <ModuleRow module={m} theme={theme} />,
      })),
    [modules, theme],
  )

  return (
    <Box flexDirection="column" gap={1}>
      <Select
        options={options}
        defaultFocusValue={focusedId}
        onFocus={(v: string) => onFocusChange(v as ModuleId)}
        onCancel={onCancel}
        disableSelection
        hideIndexes
      />
      <Text dimColor>{tSync('statusline.dialog.hints')}</Text>
      <Text dimColor>{tSync('statusline.dialog.hintsConfirm')}</Text>
    </Box>
  )
}

function ModuleRow({
  module,
  theme,
}: {
  module: ModuleConfig
  theme: Theme
}): React.ReactNode {
  const visible = module.visible
  const icon = effectiveIcon(module)
  const color = effectiveColor(module)
  const checkbox = visible ? '☑' : '☐'
  const iconCell = icon || '·'
  return (
    <Box>
      <Text>{checkbox} </Text>
      <Box width={12}>
        <Text bold={visible} dimColor={!visible}>
          {tSync(`statusline.module.${module.id}` as never)}
        </Text>
      </Box>
      <Box width={3}>
        <Text dimColor={!visible}>{iconCell}</Text>
      </Box>
      <Text color={resolveColor(theme, color) as never}>■</Text>
      <Text dimColor> {color}</Text>
    </Box>
  )
}

function IconPickerView({
  module,
  onPick,
  onCancel,
}: {
  module: ModuleConfig
  onPick: (icon: string) => void
  onCancel: () => void
}): React.ReactNode {
  const library = ICON_LIBRARY[module.id]
  const options = library.map((ic) => ({
    value: ic === '' ? '__none__' : ic,
    label: (
      <Box>
        <Box width={3}>
          <Text>{ic || ' '}</Text>
        </Box>
        <Text dimColor>{ic === '' ? tSync('statusline.icon.none') : ic}</Text>
      </Box>
    ),
  }))
  const current = effectiveIcon(module)
  const defaultFocus = current === '' ? '__none__' : current
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>
        {tSync('statusline.iconPicker.title', {
          module: tSync(`statusline.module.${module.id}` as never),
        })}
      </Text>
      <Select
        options={options}
        defaultFocusValue={defaultFocus}
        onChange={(v: string) => onPick(v === '__none__' ? '' : v)}
        onCancel={onCancel}
        hideIndexes
      />
      <Text dimColor>{tSync('statusline.dialog.pickHints')}</Text>
    </Box>
  )
}

function ColorPickerView({
  module,
  onPick,
  onCancel,
}: {
  module: ModuleConfig
  onPick: (color: string) => void
  onCancel: () => void
}): React.ReactNode {
  const theme = getTheme(resolveThemeSetting(getGlobalConfig().theme))
  const options = COLOR_TOKENS.map((c) => ({
    value: c.token,
    label: (
      <Box>
        <Text color={resolveColor(theme, c.token) as never}>■ </Text>
        <Text>{tSync(c.labelKey as never)}</Text>
        <Text dimColor> · {c.token}</Text>
      </Box>
    ),
  }))
  const current = effectiveColor(module)
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>
        {tSync('statusline.colorPicker.title', {
          module: tSync(`statusline.module.${module.id}` as never),
        })}
      </Text>
      <Select
        options={options}
        defaultFocusValue={current}
        onChange={(v: string) => onPick(v)}
        onCancel={onCancel}
        hideIndexes
      />
      <Text dimColor>{tSync('statusline.dialog.pickHints')}</Text>
    </Box>
  )
}

function resolveColor(theme: Theme, token: string): string {
  const value = (theme as unknown as Record<string, string>)[token]
  return value ?? token
}

// ─── Public helper to wire into the slash command ──────────────────────────

export function createStatuslineDialog(
  onDone: LocalJSXCommandOnDone,
  saveAndApply: (next: ModuleConfig[]) => void,
): React.ReactNode {
  // Wrapper to read current settings at mount time. Hooks must run inside
  // the component, so we expose a small wrapper here.
  function Wrapper(): React.ReactNode {
    const settings = useSettings()
    const initial = useMemo(
      () => mergeWithDefaults(settings?.builtInStatusBar?.modules),
      [settings?.builtInStatusBar?.modules],
    )
    return (
      <StatuslineConfigDialog
        initial={initial}
        onSave={(next) => {
          saveAndApply(next)
          onDone(tSync('statusline.saved'), { display: 'system' })
        }}
        onCancel={() => onDone(undefined, { display: 'skip' })}
      />
    )
  }
  return <Wrapper />
}
