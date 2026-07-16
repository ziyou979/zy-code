import { z } from 'zod/v4'
import { lazySchema } from '../../utils/lazySchema.js'

export const PromptRequestOptionSchema = lazySchema(() =>
  z.object({
    key: z.string().describe('Unique key for this option, returned in the response'),
    label: z.string().describe('Display text for this option'),
    description: z.string().optional().describe('Optional description shown below the label'),
  }),
)

export const PromptRequestSchema = lazySchema(() =>
  z.object({
    prompt: z
      .string()
      .describe('Request ID. Presence of this key marks the line as a prompt request.'),
    message: z.string().describe('The prompt message to display to the user'),
    options: z
      .array(PromptRequestOptionSchema())
      .describe('Available options for the user to choose from'),
  }),
)

export const PromptResponseSchema = lazySchema(() =>
  z.object({
    prompt_response: z.string().describe('The request ID from the corresponding prompt request'),
    selected: z.string().describe('The key of the selected option'),
  }),
)
