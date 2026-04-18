import { basename } from 'path';
import { toString as qrToString } from 'qrcode';
import * as React from 'react';
import { useEffect, useState } from 'react';
import { getOriginalCwd } from '../bootstrap/state.js';
import { buildActiveFooterText, buildIdleFooterText, FAILED_FOOTER_TEXT, getBridgeStatus } from '../bridge/bridgeStatusUtil.js';
import { BRIDGE_FAILED_INDICATOR, BRIDGE_READY_INDICATOR } from '../constants/figures.js';
import { useRegisterOverlay } from '../context/overlayContext.js';
// eslint-disable-next-line custom-rules/prefer-use-keybindings -- raw 'd' key for disconnect, not a configurable keybinding action
import { Box, Text, useInput } from '../ink.js';
import { useKeybindings } from '../keybindings/useKeybinding.js';
import { useAppState, useSetAppState } from '../state/AppState.js';
import { saveGlobalConfig } from '../utils/config.js';
import { getBranch } from '../utils/git.js';
import { Dialog } from './design-system/Dialog.js';
type Props = {
  onDone: () => void;
};
export function BridgeDialog({
  onDone
}: Props) {
  // @ts-ignore
  useRegisterOverlay("bridge-dialog");
  const connected = useAppState((s) => s.replBridgeConnected);
  const sessionActive = useAppState((s_0) => s_0.replBridgeSessionActive);
  const reconnecting = useAppState((s_1) => s_1.replBridgeReconnecting);
  const connectUrl = useAppState((s_2) => s_2.replBridgeConnectUrl);
  const sessionUrl = useAppState((s_3) => s_3.replBridgeSessionUrl);
  const error = useAppState((s_4) => s_4.replBridgeError);
  const explicit = useAppState((s_5) => s_5.replBridgeExplicit);
  const environmentId = useAppState((s_6) => s_6.replBridgeEnvironmentId);
  const sessionId = useAppState((s_7) => s_7.replBridgeSessionId);
  const verbose = useAppState((s_8) => s_8.verbose);
  const setAppState = useSetAppState();
  const [showQR, setShowQR] = useState(false);
  const [qrText, setQrText] = useState("");
  const [branchName, setBranchName] = useState("");
  const repoName = basename(getOriginalCwd());
  useEffect(() => {
    getBranch().then(setBranchName).catch(_temp1);
  }, []);
  const displayUrl = sessionActive ? sessionUrl : connectUrl;
  useEffect(() => {
    if (!showQR || !displayUrl) {
      setQrText("");
      return;
    }
    // @ts-ignore
    qrToString(displayUrl, {
      type: "utf8",
      errorCorrectionLevel: "L",
      small: true
    }).then(setQrText).catch(() => setQrText(""));
  }, [showQR, displayUrl]);
  useKeybindings({
    "confirm:yes": onDone,
    "confirm:toggle": () => {
      setShowQR((prev) => !prev);
    }
  }, {
    context: "Confirmation"
  });
  useInput((input) => {
    if (input === "d") {
      if (explicit) {
        saveGlobalConfig((current) => {
          if (current.remoteControlAtStartup === false) {
            return current;
          }
          return {
            ...current,
            remoteControlAtStartup: false
          };
        });
      }
      setAppState((prev_0) => {
        if (!prev_0.replBridgeEnabled) {
          return prev_0;
        }
        return {
          ...prev_0,
          replBridgeEnabled: false
        };
      });
      onDone();
    }
  });
  const {
    label: statusLabel,
    color: statusColor
  } = getBridgeStatus({
    error,
    connected,
    sessionActive,
    reconnecting
  });
  const indicator = error ? BRIDGE_FAILED_INDICATOR : BRIDGE_READY_INDICATOR;
  let BoxComponent;
  let DialogComponent;
  let footerText;


  let boxElement;

  let t16;

  const qrLines = qrText ? qrText.split("\n").filter((l) => l.length > 0) : [];
  const contextParts = [];
  if (repoName) {
    contextParts.push(repoName);
  }
  if (branchName) {
    contextParts.push(branchName);
  }
  const contextSuffix = contextParts.length > 0 ? " \xB7 " + contextParts.join(" \xB7 ") : "";
  footerText = error ? FAILED_FOOTER_TEXT : displayUrl ? sessionActive ? buildActiveFooterText(displayUrl) : buildIdleFooterText(displayUrl) : undefined;
  DialogComponent = Dialog;

  t16 = onDone;

  BoxComponent = Box;


  const boxElement2 = <Box flexDirection="column">{<Text>{<Text color={statusColor}>{indicator} {statusLabel}</Text>}{<Text dimColor={true}>{contextSuffix}</Text>}</Text>}{error && <Text color="error">{error}</Text>}{verbose && environmentId && <Text dimColor={true}>Environment: {environmentId}</Text>}{verbose && sessionId && <Text dimColor={true}>Session: {sessionId}</Text>}</Box>;
  boxElement = showQR && qrLines.length > 0 && <Box flexDirection="column">{qrLines.map((line, i) => <Text key={i}>{line}</Text>)}</Box>;
  return <DialogComponent title={"Remote Control"} onCancel={t16} hideInputGuide={true}>{<BoxComponent flexDirection={"column"} gap={1}>{boxElement2}{boxElement}{footerText && <Text dimColor={true}>{footerText}</Text>}{<Text dimColor={true}>d to disconnect · space for QR code · Enter/Esc to close</Text>}</BoxComponent>}</DialogComponent>;
}
function _temp1() {}