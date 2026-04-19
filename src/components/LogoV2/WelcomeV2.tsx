import React from 'react';
import { Box, Text, useTheme } from 'src/ink.js';
import { env } from '../../utils/env.js';
const WELCOME_V2_WIDTH = 58;

/**
 * Unified welcome pattern — Claude Code style with nebula clouds, ZY block text, and jellyfish mascot.
 */
function WelcomeContent({ separator }: { separator: string }) {
  // ZY block text (15 chars wide)
  const zy1 = "███████  ██  ██";   // 15
  const zy2 = "      ██   ████";   // 15
  const zy3 = "   ███      ██";    // 14
  const zy4 = "  ██       ██";     // 13
  const zy5 = "███████    ██";     // 13

  return (
    <Box width={WELCOME_V2_WIDTH} flexDirection="column">
      <Text><Text color="zy">{"Hello, ready to build?"} </Text><Text dimColor={true}>v{MACRO.VERSION}</Text></Text>
      <Text>{separator}</Text>
      <Text>{"                                                          "}</Text>
      <Text>{"       "}<Text bold={true}>*</Text><Text>{"        ░░░░░░" + " ".repeat(36)}</Text>
      <Text>{"    ░░░░░░░░░░" + " ".repeat(22) + "███▓▓░░░░░░" + " ".repeat(11)}</Text>
      <Text>{"   ░░░░░░░░░░░░░░░░░░      *        "}<Text dimColor={true}>{"███▓▓░" + " ".repeat(16)}</Text>
      <Text>{"                                                          "}</Text>
      <Text>{" ".repeat(21)}<Text color="clawd_body">{zy1}</Text><Text>{" ".repeat(22)}</Text>
      <Text>{" ".repeat(21)}<Text color="clawd_body">{zy2}</Text><Text>{" ".repeat(22)}</Text>
      <Text>{" ".repeat(22)}<Text color="clawd_body">{zy3}</Text><Text>{" ".repeat(22)}</Text>
      <Text>{" ".repeat(22)}<Text color="clawd_body">{zy4}</Text><Text>{" ".repeat(23)}</Text>
      <Text>{" ".repeat(22)}<Text color="clawd_body">{zy5}</Text><Text>{" ".repeat(23)}</Text>
      <Text>{"                                                          "}</Text>
      <Text>{"              "}<Text color="clawd_body">▄▀▀▀▀▀▀▀▄</Text><Text>{"         "}<Text dimColor={true}>*</Text><Text>{" ".repeat(25)}</Text>
      <Text>{"             "}<Text color="clawd_body">█  ●   ●  █</Text><Text>{" ".repeat(34)}</Text>
      <Text>{"              "}<Text color="clawd_body">█  ▀▀▀  █</Text><Text>{" ".repeat(35)}</Text>
      <Text>{"              "}<Text color="clawd_body">▀▄     ▄▀</Text><Text>{"      "}<Text bold={true}>*</Text><Text>{" ".repeat(28)}</Text>
      <Text>{"               "}<Text color="clawd_body">▀▄▀▀▀▄▀</Text><Text>{" ".repeat(36)}</Text>
      <Text>{"                                                          "}</Text>
      <Text>{separator}</Text>
    </Box>
  );
}

export function WelcomeV2() {
  const [theme] = useTheme();
  const isLight = ["light", "light-daltonized", "light-ansi"].includes(theme);
  const separator = isLight
    ? "──────────────────────────────────────────────────────────"
    : "……………………………………………………………………………………………………";

  if (env.terminal === "Apple_Terminal") {
    return <AppleTerminalWelcomeV2 theme={theme} welcomeMessage="Hello, ready to build?" />;
  }

  return <WelcomeContent separator={separator} />;
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

  return <WelcomeContent separator={separator} />;
}
