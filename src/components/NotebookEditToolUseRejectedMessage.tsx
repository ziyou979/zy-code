import { relative } from 'path';
import * as React from 'react';
import { getCwd } from 'src/utils/cwd.js';
import { tSync } from '../i18n/index.js';
import { Box, Text } from '../ink.js';
import { HighlightedCode } from './HighlightedCode.js';
import { MessageResponse } from './MessageResponse.js';
type Props = {
  notebook_path: string;
  cell_id: string | undefined;
  new_source: string;
  cell_type?: 'code' | 'markdown';
  edit_mode?: 'replace' | 'insert' | 'delete';
  verbose: boolean;
};
export function NotebookEditToolUseRejectedMessage({
  notebook_path,
  cell_id,
  new_source,
  cell_type,
  edit_mode = "replace",
  verbose
}: Props) {
  const operation = edit_mode === "delete" ? tSync('notebookEdit.rejectedDelete') : tSync('notebookEdit.rejectedEditCell', { mode: edit_mode });
  const t3 = verbose ? notebook_path : relative(getCwd(), notebook_path);
  return <MessageResponse><Box flexDirection="column">{<Box flexDirection="row">{<Text color="subtle">{operation} </Text>}{<Text bold={true} color="subtle">{t3}</Text>}{<Text color="subtle"> {tSync('notebookEdit.atCell', { cellId: cell_id })}</Text>}</Box>}{edit_mode !== "delete" && <Box marginTop={1} flexDirection="column"><HighlightedCode code={new_source} filePath={cell_type === "markdown" ? "file.md" : "file.py"} dim={true} /></Box>}</Box></MessageResponse>;
}
