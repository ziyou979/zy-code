// Keybinding Types

/** A single parsed keystroke with its modifiers */
type ParsedKeystroke = {
  key: string
  ctrl: boolean
  alt: boolean
  shift: boolean
  meta: boolean
  super: boolean
}

/** A chord is a sequence of keystrokes (e.g., "ctrl+k ctrl+s") */
type Chord = ParsedKeystroke[]

/** A parsed keybinding with its chord, action, and context */
type ParsedBinding = {
  chord: Chord
  action: string | null
  context: KeybindingContextName
}

/** A keybinding block from config JSON */
type KeybindingBlock = {
  context: KeybindingContextName
  bindings: Record<string, string | null>
}

/** Valid context names for keybindings */
type KeybindingContextName =
  | 'Global'
  | 'Chat'
  | 'Autocomplete'
  | 'Settings'
  | 'Confirmation'
  | 'Tabs'
  | 'Transcript'
  | 'HistorySearch'
  | 'Task'
  | 'ThemePicker'
  | 'Scroll'
  | 'Help'
  | 'Attachments'
  | 'Footer'
  | 'MessageSelector'
  | 'MessageActions'
  | 'DiffDialog'
  | 'ModelPicker'
  | 'Select'
  | 'Plugin'

/** A string literal type for keybinding action names (e.g., 'app:toggleTranscript') */
type KeybindingAction = string

export type {
  ParsedKeystroke,
  Chord,
  ParsedBinding,
  KeybindingBlock,
  KeybindingContextName,
  KeybindingAction,
}
