import * as React from 'react';
import { useState } from 'react';
import { getSlowOperations } from '../bootstrap/state.js';
import { Text, useInterval } from '../ink.js';
import { isDevEnv, isInternalBuild } from '../utils/envUtils.js';

// Show DevBar for dev builds or all ants
function shouldShowDevBar(): boolean {
  return isDevEnv() || isInternalBuild();
}
export function DevBar() {
  const [slowOps, setSlowOps] = useState(getSlowOperations);
  useInterval(() => {
    setSlowOps(getSlowOperations());
  }, shouldShowDevBar() ? 500 : null);
  if (!shouldShowDevBar() || slowOps.length === 0) {
    return null;
  }
  const recentOps = slowOps.slice(-3).map(op => `${op.operation} (${Math.round(op.durationMs)}ms)`).join(" \xB7 ");
  return <Text wrap="truncate-end" color="warning">[INNER-ONLY] slow sync: {recentOps}</Text>;
}
