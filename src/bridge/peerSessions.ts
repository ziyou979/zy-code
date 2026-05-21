/**
 * Posts a message to another Zy session (inter-session communication).
 * This is a stub implementation for external builds.
 */
export async function postInterZyMessage(
  _target: string,
  _message: string,
): Promise<{ ok: boolean; error?: string }> {
  // Stub: always fails in external builds since peer sessions are not supported
  return {
    ok: false,
    error: 'inter-session messaging is not available in this build',
  }
}
