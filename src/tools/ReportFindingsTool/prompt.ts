export const REPORT_FINDINGS_TOOL_NAME = 'ReportFindings'

export const DESCRIPTION = 'Report the verified findings produced by an active code-review workflow'

export const PROMPT = `Use this tool only when the active code-review instructions explicitly tell you to report findings.

Call it exactly once after verification, with the most severe findings first. Pass an empty findings array when the review found no actionable issue. Do not repeat the same findings in prose after calling this tool.

When a review also asks you to apply fixes, call this tool before editing. After attempting the fixes, you may call it once more with the same findings and an outcome for each item.`
