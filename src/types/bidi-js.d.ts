declare module 'bidi-js' {
  interface BidiInstance {
    getReorderSegments(
      text: string,
      direction: 'ltr' | 'rtl' | 'auto',
      options?: Record<string, unknown>,
    ): Array<{ start: number; end: number; level: number }>
    getEmbeddingLevels(
      text: string,
      direction?: 'ltr' | 'rtl' | 'auto',
    ): { levels: Uint8Array; paragraphs: Array<{ start: number; end: number; level: number }> }
    getMirroredCharacter(char: string): string | null
    getMirroredCharactersMap(text: string, levels: Uint8Array): Map<number, string>
    getReorderedString(
      text: string,
      segments: Array<{ start: number; end: number; level: number }>,
    ): string
  }

  function bidiFactory(): BidiInstance
  export default bidiFactory
}
