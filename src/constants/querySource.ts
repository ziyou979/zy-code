// Query Source Constants

export const QUERY_SOURCES = ['cli', 'sdk', 'ide', 'web', 'api'] as const
export type QuerySource = (typeof QUERY_SOURCES)[number]
