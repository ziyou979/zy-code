export type ContentReplacementRecord = {
  kind: 'tool-result'
  toolUseId: string
  replacement: string
}

export type ContentReplacementState = {
  seenIds: Set<string>
  replacements: Map<string, string>
}
