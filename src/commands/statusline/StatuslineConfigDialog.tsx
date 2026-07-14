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
  type ModuleConfig,
  type ModuleId,
  mergeWithDefaults,
} from '../../components/statusbar/statusbarModuleDefaults.js'
import { BALLOT_BOX, CHECKBOX_CHECKED } from '../../constants/figures.js'
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js'
import { useSettings } from '../../hooks/useSettings.js'
import { tSync } from '../../i18n/index.js'
import { stringWidth } from '../../ink/stringWidth.js'
import { Box, Text, useInput } from '../../ink.js'
import { useAppState } from '../../state/AppState.js'
import type { LocalJSXCommandOnDone } from '../types.js'
import { getGlobalConfig } from '../../services/config/config.js'
import { getEffectiveStatuslineConfig } from '../../services/settings/statuslineConfig.js'
import { resolveThemeSetting } from '../../utils/systemTheme.js'
import { getTheme, type Theme } from '../../utils/theme.js'

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
    setModules((prev) => prev.map((m) => (m.id === focusedId ? { ...m, visible: !m.visible } : m)))
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

  const moveFocusedToTop = useCallback(() => {
    setModules((prev) => {
      const idx = prev.findIndex((m) => m.id === focusedId)
      if (idx <= 0) return prev
      const next = prev.slice()
      const [item] = next.splice(idx, 1)
      next.unshift(item!)
      return next
    })
  }, [focusedId])

  const moveFocusedToBottom = useCallback(() => {
    setModules((prev) => {
      const idx = prev.findIndex((m) => m.id === focusedId)
      if (idx < 0 || idx === prev.length - 1) return prev
      const next = prev.slice()
      const [item] = next.splice(idx, 1)
      next.push(item!)
      return next
    })
  }, [focusedId])

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
      setModules((prev) => prev.map((m) => (m.id === focusedId ? { ...m, icon } : m)))
      setMode('main')
    },
    [focusedId],
  )

  const setColor = useCallback(
    (color: string) => {
      setModules((prev) => prev.map((m) => (m.id === focusedId ? { ...m, color } : m)))
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
      if (input === 'g') {
        moveFocusedToTop()
        return
      }
      if (input === 'G') {
        moveFocusedToBottom()
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
    thinkingEnabled: thinkingEnabled ?? false,
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
      modules.map((m, index) => ({
        value: m.id,
        label: <ModuleRow module={m} theme={theme} index={index} total={modules.length} />,
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

/**
 * Visual-width padEnd: pads a string with spaces so its rendered width
 * (accounting for double-cell CJK chars) equals `width` cells.
 */
function padVisual(s: string, width: number): string {
  const w = stringWidth(s)
  if (w >= width) {
    return s
  }
  return s + ' '.repeat(width - w)
}

/**
 * Single-row label for the module list. Returned as Select option `label`,
 * which Select wraps in a <Text> — so this MUST be Text-only (no <Box>),
 * otherwise Ink throws "<Box> can't be nested inside <Text>". Column
 * alignment is done via space-padding instead of Box widths.
 */
function ModuleRow({
  module,
  theme,
  index,
  total,
}: {
  module: ModuleConfig
  theme: Theme
  index: number
  total: number
}): React.ReactNode {
  const visible = module.visible
  const icon = effectiveIcon(module)
  const color = effectiveColor(module)
  const checkbox = visible ? CHECKBOX_CHECKED : BALLOT_BOX
  const iconCell = icon || '·'
  const name = tSync(`statusline.module.${module.id}` as never)
  // 位置编号（3 字符宽，如 "1. "）
  const posLabel = `${index + 1}.`
  const posPadded = padVisual(posLabel, 3)
  // 方向箭头（2 字符宽）
  const arrows = index === 0 ? '↓' : index === total - 1 ? '↑' : '↕'
  // Column widths in terminal cells: name=14, icon=3 (with trailing space).
  const namePadded = padVisual(name, 14)
  const iconPadded = padVisual(iconCell, 3)
  return (
    <Text>
      {checkbox} <Text dimColor>{posPadded}</Text>
      <Text bold={visible} dimColor={!visible}>
        {namePadded}
      </Text>
      <Text dimColor={!visible}>{iconPadded}</Text>
      <Text color={resolveColor(theme, color) as never}>■</Text>
      <Text dimColor> {color}</Text>
      <Text dimColor> {arrows}</Text>
    </Text>
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
    // Text-only label (Select wraps in <Text>); pad icon to fixed cell width.
    label: (
      <Text>
        {padVisual(ic || ' ', 3)}
        <Text dimColor>{ic === '' ? tSync('statusline.icon.none') : ic}</Text>
      </Text>
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
    // Text-only label (Select wraps in <Text>); inline color swatch is a
    // nested <Text color>, which is legal — only <Box> is forbidden here.
    label: (
      <Text>
        <Text color={resolveColor(theme, c.token) as never}>■ </Text>
        {tSync(c.labelKey as never)}
        <Text dimColor> · {c.token}</Text>
      </Text>
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
