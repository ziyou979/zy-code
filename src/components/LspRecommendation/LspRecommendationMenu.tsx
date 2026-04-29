import * as React from 'react';
import { Box, Text } from '../../ink.js';
import { tSync } from 'src/i18n/index.js';
import { Select } from '../CustomSelect/select.js';
import { PermissionDialog } from '../permissions/PermissionDialog.js';
type Props = {
  pluginName: string;
  pluginDescription?: string;
  fileExtension: string;
  onResponse: (response: 'yes' | 'no' | 'never' | 'disable') => void;
};
const AUTO_DISMISS_MS = 30_000;
export function LspRecommendationMenu({
  pluginName,
  pluginDescription,
  fileExtension,
  onResponse
}: Props): React.ReactNode {
  // 使用 ref 避免 onResponse 变化时重置定时器
  const onResponseRef = React.useRef(onResponse);
  onResponseRef.current = onResponse;

  // 30 秒自动关闭定时器——计为忽略（no）
  React.useEffect(() => {
    const timeoutId = setTimeout(ref => ref.current('no'), AUTO_DISMISS_MS, onResponseRef);
    return () => clearTimeout(timeoutId);
  }, []);
  function onSelect(value: string): void {
    switch (value) {
      case 'yes':
        onResponse('yes');
        break;
      case 'no':
        onResponse('no');
        break;
      case 'never':
        onResponse('never');
        break;
      case 'disable':
        onResponse('disable');
        break;
    }
  }
  const options = [{
    label: <Text>
          {tSync('lsp.yesInstallPlugin', { pluginName })}
        </Text>,
    value: 'yes'
  }, {
    label: tSync('lsp.noNotNow'),
    value: 'no'
  }, {
    label: <Text>
          {tSync('lsp.neverForPlugin', { pluginName })}
        </Text>,
    value: 'never'
  }, {
    label: tSync('lsp.disableAllRecommendations'),
    value: 'disable'
  }];
  return <PermissionDialog title={tSync('lsp.title')}>
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Box marginBottom={1}>
          <Text dimColor>
            {tSync('lsp.intelligenceDesc')}
          </Text>
        </Box>
        <Box>
          <Text dimColor>{tSync('lsp.pluginLabel')}</Text>
          <Text> {pluginName}</Text>
        </Box>
        {pluginDescription && <Box>
            <Text dimColor>{pluginDescription}</Text>
          </Box>}
        <Box>
          <Text dimColor>{tSync('lsp.triggeredBy')}</Text>
          <Text> {tSync('lsp.fileExtension', { fileExtension })}</Text>
        </Box>
        <Box marginTop={1}>
          <Text>{tSync('lsp.wouldYouInstall')}</Text>
        </Box>
        <Box>
          <Select options={options} onChange={onSelect} onCancel={() => onResponse('no')} />
        </Box>
      </Box>
    </PermissionDialog>;
}
