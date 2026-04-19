import React from 'react';
import { Box, Text, useTheme } from 'src/ink.js';
import { env } from '../../utils/env.js';
const WELCOME_V2_WIDTH = 58;

export function WelcomeV2() {
  const [theme] = useTheme();
  if (env.terminal === "Apple_Terminal") {
    return <AppleTerminalWelcomeV2 theme={theme} welcomeMessage="Hello, ready to build?" />;
  }
  // ── Light theme ──
  if (["light", "light-daltonized", "light-ansi"].includes(theme)) {
    return (
      <Box width={WELCOME_V2_WIDTH} flexDirection="column">
        <Text><Text color="zy">{"Hello, ready to build?"} </Text><Text dimColor={true}>v{MACRO.VERSION}</Text></Text>
        <Text>{"──────────────────────────────────────────────────────────"}</Text>
        <Text>{"                                                          "}</Text>
        <Text>{"              "}<Text color="clawd_body">▄▀▀▀▀▀▀▀▄</Text>{"                            "}</Text>
        <Text>{"             "}<Text color="clawd_body">█  ●   ●  █</Text>{"                           "}</Text>
        <Text>{"              "}<Text color="clawd_body">█  ▀▀▀  █</Text>{"                            "}</Text>
        <Text>{"              "}<Text color="clawd_body">▀▄     ▄▀</Text>{"                            "}</Text>
        <Text>{"               "}<Text color="clawd_body">▀▄▀▀▀▄▀</Text>{"                             "}</Text>
        <Text>{"                                                          "}</Text>
        <Text>{"──────────────────────────────────────────────────────────"}</Text>
      </Box>
    );
  }
  // ── Dark theme ──

  return (
    <Box width={WELCOME_V2_WIDTH} flexDirection="column">
      <Text><Text color="zy">{"Hello, ready to build?"} </Text><Text dimColor={true}>v{MACRO.VERSION}</Text></Text>
      <Text>{"……………………………………………………………………………………………………"}</Text>
      <Text>{"                                                          "}</Text>
      <Text>{"     *          "}<Text dimColor={true}>{"╭──────╮"}</Text>{"          "}<Text bold={true}>*</Text>{"               "}</Text>
      <Text>{"             "}<Text dimColor={true}>{"╯  ZY  ╰"}</Text>{"                      "}</Text>
      <Text>{"                  *         "}<Text dimColor={true}>{"╭──────╮"}</Text>{"            "}</Text>
      <Text>{"                              "}<Text dimColor={true}>{"╰──────╯"}</Text>{"            "}</Text>
      <Text>{"              "}<Text color="clawd_body">▄▀▀▀▀▀▀▀▄</Text>{"         "}<Text dimColor={true}>*</Text>{"              "}</Text>
      <Text>{"             "}<Text color="clawd_body">█  ●   ●  █</Text>{"                           "}</Text>
      <Text>{"              "}<Text color="clawd_body">█  ▀▀▀  █</Text>{"                           "}</Text>
      <Text>{"              "}<Text color="clawd_body">▀▄     ▄▀</Text>{"      "}<Text bold={true}>*</Text>{"                "}</Text>
      <Text>{"               "}<Text color="clawd_body">▀▄▀▀▀▄▀</Text>{"                           "}</Text>
      <Text>{"                                                          "}</Text>
      <Text dimColor={true}>{"  ♡  ♡  ♡  ♡  ♡  ♡  ♡  ♡  ♡  ♡                        "}</Text>
      <Text dimColor={true}>{"  |  |  |  |  |  |  |  |  |  |                            "}</Text>
      <Text>{"……………………………………………………………………………………………………"}</Text>
    </Box>
  );
}

type AppleTerminalWelcomeV2Props = {
  theme: string;
  welcomeMessage: string;
};

function AppleTerminalWelcomeV2({
  theme,
  welcomeMessage
}: AppleTerminalWelcomeV2Props) {
  const isLightTheme = ["light", "light-daltonized", "light-ansi"].includes(theme);
  const separator = isLightTheme ? "──────────────────────────────────────────────────────────" : "……………………………………………………………………………………………………";

  return (
    <Box width={WELCOME_V2_WIDTH} flexDirection="column">
      <Text><Text color="zy">{welcomeMessage} </Text><Text dimColor={true}>v{MACRO.VERSION}</Text></Text>
      <Text>{separator}</Text>
      <Text>{"                                                          "}</Text>
      <Text>{"              "}<Text color="clawd_body">▄▀▀▀▀▀▀▀▄</Text>{"                            "}</Text>
      <Text>{"             "}<Text color="clawd_body">█  ●   ●  █</Text>{"                           "}</Text>
      <Text>{"              "}<Text color="clawd_body">█  ▀▀▀  █</Text>{"                            "}</Text>
      <Text>{"              "}<Text color="clawd_body">▀▄     ▄▀</Text>{"                            "}</Text>
      <Text>{"               "}<Text color="clawd_body">▀▄▀▀▀▄▀</Text>{"                             "}</Text>
      <Text>{"                                                          "}</Text>
      <Text>{separator}</Text>
    </Box>
  );
}
