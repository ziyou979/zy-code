// Stub for src/services/contextCollapse/persist.ts

export type ContextCollapseEntry = {
  id: string
  content: string
}

export type ContextCollapseSnapshot = {
  entries: ContextCollapseEntry[]
}

export function restoreFromEntries(
  _entries: ContextCollapseEntry[],
  _snapshot: ContextCollapseSnapshot | undefined,
): void {}

export function persistContextCollapse(_data: unknown): void {}
