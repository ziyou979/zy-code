/**
 * Terminal state — the query loop has reached a final state and should stop.
 * Callers attach an arbitrary `reason` string plus optional metadata.
 */
export type Terminal = {
  reason: string;
  [key: string]: unknown;
};

/**
 * Continue state — the query loop should keep running.
 * Callers attach an arbitrary `reason` string plus optional metadata.
 */
export type Continue = {
  reason: string;
  [key: string]: unknown;
};

/**
 * Union type for query transition states.
 */
export type TransitionState = Terminal | Continue;
