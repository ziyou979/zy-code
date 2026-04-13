import * as React from 'react';
import { use } from 'react';
import { Box } from '../ink.js';
import type { AgentDefinitionsResult } from '../tools/AgentTool/loadAgentsDir.js';
import { getMemoryFiles } from '../utils/zymd.js';
import { getGlobalConfig } from '../utils/config.js';
import { getActiveNotices } from '../utils/statusNoticeDefinitions.js';
type Props = {
  agentDefinitions?: AgentDefinitionsResult;
};

/**
 * StatusNotices contains the information displayed to users at startup. We have
 * moved neutral or positive status to src/components/Status.tsx instead, which
 * users can access through /status.
 */
export function StatusNotices(t0) {
  const {
    agentDefinitions
  } = t0 === undefined ? {} : t0;
  const t1 = getGlobalConfig();
  const t2 = getMemoryFiles();
  const context = {
    config: t1,
    agentDefinitions,
    memoryFiles: use(t2)
  };
  const activeNotices = getActiveNotices(context);
  if (activeNotices.length === 0) {
    return null;
  }
  const T0 = Box;
  const t5 = activeNotices.map(notice => <React.Fragment key={notice.id}>{notice.render(context)}</React.Fragment>);
  return <T0 flexDirection={"column"} paddingLeft={1}>{t5}</T0>;
}
