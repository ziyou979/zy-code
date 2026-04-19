export function isBilledAsExtraUsage(model: string | null, isOpus1mMerged: boolean): boolean {
  // No subscriber context, so extra usage is never billed
  return false;
}
