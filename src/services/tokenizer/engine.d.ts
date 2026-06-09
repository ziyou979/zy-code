export class PreTrainedTokenizer {
  constructor(tokenizerJSON: Record<string, unknown>, tokenizerConfig: Record<string, unknown>)
  encode(text: string): number[]
}
