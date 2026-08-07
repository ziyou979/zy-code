export const REPORT_FINDINGS_TOOL_NAME = 'ReportFindings'

// 描述与用法对齐 Claude Code 2.1.220 的 ReportFindings 工具
export const DESCRIPTION =
  'Report code-review findings as a typed list so the host UI can render them'

export const PROMPT = `Use this tool only when the active code-review instructions tell you to report findings with this tool; otherwise follow whatever output format those instructions specify.

When reporting a review's results, call it once with the verified findings ranked most-severe first (empty array if nothing survived verification) and do not also print the findings as text.

When re-reporting after applying fixes (only if the apply instructions ask for it), set \`outcome\` on each finding to what actually happened.`
