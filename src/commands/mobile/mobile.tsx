import { toString as qrToString } from 'qrcode';
import * as React from 'react';
import { useEffect, useState } from 'react';
import { Pane } from '../../components/design-system/Pane.js';
import { Box, Text } from '../../ink.js';
import { useKeybinding } from '../../keybindings/useKeybinding.js';
import type { LocalJSXCommandOnDone } from '../../types/command.js';
type Platform = 'ios' | 'android';
type Props = {
  onDone: () => void;
};
const PLATFORMS: Record<Platform, {
  url: string;
}> = {
  ios: {
    url: 'https://apps.apple.com/app/zy-by-anthropic/id6473753684'
  },
  android: {
    url: 'https://play.google.com/store/apps/details?id=com.anthropic.zy'
  }
};
function MobileQRCode({
  onDone
}: Props) {
  const [platform, setPlatform] = useState("ios");
  const [qrCodes, setQrCodes] = useState({
    ios: "",
    android: ""
  });
  const {
    url
  } = PLATFORMS[platform];
  const qrCode = qrCodes[platform];
  useEffect(() => {
    const generateQRCodes = async function generateQRCodes() {
      const [ios, android] = await Promise.all([qrToString(PLATFORMS.ios.url, {
        type: "utf8",
        errorCorrectionLevel: "L"
      }), qrToString(PLATFORMS.android.url, {
        type: "utf8",
        errorCorrectionLevel: "L"
      })]);
      setQrCodes({
        ios,
        android
      });
    };
    generateQRCodes().catch(_temp);
  }, []);
  const handleClose = () => {
    onDone();
  };
  useKeybinding("confirm:no", handleClose, {
    context: "Confirmation"
  });
  const handleKeyDown = function handleKeyDown(e) {
    if (e.key === "q" || e.ctrl && e.key === "c") {
      e.preventDefault();
      onDone();
      return;
    }
    if (e.key === "tab" || e.key === "left" || e.key === "right") {
      e.preventDefault();
      setPlatform(prev => prev === "ios" ? "android" : "ios");
    }
  };
  const lines = qrCode.split("\n").filter(line => line.length > 0);
  const T1 = Pane;
  const T0 = Box;
  const t13 = lines.map((line_0, i) => <Text key={i}>{line_0}</Text>);
  return <T1>{<T0 flexDirection={"column"} tabIndex={0} autoFocus={true} onKeyDown={handleKeyDown}>{<Text> </Text>}{<Text> </Text>}{t13}{<Text> </Text>}{<Text> </Text>}{<Box flexDirection="row" gap={2}>{<Text>{<Text bold={platform === "ios"} underline={platform === "ios"}>iOS</Text>}{<Text dimColor={true}>{" / "}</Text>}{<Text bold={platform === "android"} underline={platform === "android"}>Android</Text>}</Text>}{<Text dimColor={true}>(tab to switch, esc to close)</Text>}</Box>}{<Text dimColor={true}>{url}</Text>}</T0>}</T1>;
}
function _temp() {}
export async function call(onDone: LocalJSXCommandOnDone): Promise<React.ReactNode> {
  return <MobileQRCode onDone={onDone} />;
}
