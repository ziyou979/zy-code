// Stub for src/services/contextCollapse/index.ts

export function isContextCollapseEnabled(): boolean {
  return false
}

export function getStats(): {
  collapsedSpans: number;
  collapsedMessages: number;
  stagedSpans: number;
  health: {
    totalSpawns: number;
    totalErrors: number;
    lastError: string | null;
    emptySpawnWarningEmitted: boolean;
    totalEmptySpawns: number;
  };
} {
  return {
    collapsedSpans: 0,
    collapsedMessages: 0,
    stagedSpans: 0,
    health: {
      totalSpawns: 0,
      totalErrors: 0,
      lastError: null,
      emptySpawnWarningEmitted: false,
      totalEmptySpawns: 0,
    },
  }
}

export function resetContextCollapse(): void {}

export function applyCollapsesIfNeeded(_messages: unknown[]): unknown[] {
  return _messages
}

export function recoverFromOverflow(_messages: unknown[]): unknown[] {
  return _messages
}

export function isWithheldPromptTooLong(): boolean {
  return false
}

export function initContextCollapse(): void {}

export function subscribe(_onStoreChange: () => void): () => void {
  return () => {}
}
