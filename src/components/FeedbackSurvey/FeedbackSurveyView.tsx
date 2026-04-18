import React from 'react';
import { Box, Text } from '../../ink.js';
import { useDebouncedDigitInput } from './useDebouncedDigitInput.js';
import type { FeedbackSurveyResponse } from './utils.js';
type Props = {
  onSelect: (option: FeedbackSurveyResponse) => void;
  inputValue: string;
  setInputValue: (value: string) => void;
  message?: string;
};
const RESPONSE_INPUTS = ['0', '1', '2', '3'] as const;
type ResponseInput = (typeof RESPONSE_INPUTS)[number];
const inputToResponse: Record<ResponseInput, FeedbackSurveyResponse> = {
  '0': 'dismissed' as any,
  '1': 'bad' as any,
  '2': 'fine' as any,
  '3': 'good' as any
} as const;
export const isValidResponseInput = (input: string): input is ResponseInput => (RESPONSE_INPUTS as readonly string[]).includes(input);
const DEFAULT_MESSAGE = 'How is Zy doing this session? (optional)';
export function FeedbackSurveyView({
  onSelect,
  inputValue,
  setInputValue,
  message = DEFAULT_MESSAGE
}) {
  useDebouncedDigitInput({
    inputValue,
    setInputValue,
    isValidDigit: isValidResponseInput,
    onDigit: digit => onSelect(inputToResponse[digit])
  });
  return <Box flexDirection="column" marginTop={1}>{<Box>{<Text color="ansi:cyan">● </Text>}<Text bold={true}>{message}</Text></Box>}{<Box marginLeft={2}>{<Box width={10}><Text><Text color="ansi:cyan">1</Text>: Bad</Text></Box>}{<Box width={10}><Text><Text color="ansi:cyan">2</Text>: Fine</Text></Box>}{<Box width={10}><Text><Text color="ansi:cyan">3</Text>: Good</Text></Box>}<Box><Text><Text color="ansi:cyan">0</Text>: Dismiss</Text></Box></Box>}</Box>;
}
