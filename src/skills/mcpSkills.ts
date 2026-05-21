/**
 * Fetches MCP skills for a given client by discovering skill:// resources.
 * This is a stub implementation for external builds.
 */
export async function fetchMcpSkillsForClient(_client: unknown): Promise<unknown[]> {
  // Stub: returns empty array in external builds
  return []
}

// Add cache property to match the expected interface
fetchMcpSkillsForClient.cache = new Map()
