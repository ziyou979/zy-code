import { z } from 'zod/v4'
import { count } from '../../utils/array.js'
import { lazySchema } from '../../utils/lazySchema.js'

type McpServerEntryDescriptions = {
  nameDescription: string
  commandDescription: string
  urlDescription: string
}

export function createMcpServerEntrySchema({
  commandDescription,
  nameDescription,
  urlDescription,
}: McpServerEntryDescriptions) {
  return lazySchema(() =>
    z
      .object({
        serverName: z
          .string()
          .regex(
            /^[a-zA-Z0-9_-]+$/,
            'Server name can only contain letters, numbers, hyphens, and underscores',
          )
          .optional()
          .describe(nameDescription),
        serverCommand: z
          .array(z.string())
          .min(1, 'Server command must have at least one element (the command)')
          .optional()
          .describe(commandDescription),
        serverUrl: z.string().optional().describe(urlDescription),
      })
      .refine(
        (data) => {
          const defined = count(
            [
              data.serverName !== undefined,
              data.serverCommand !== undefined,
              data.serverUrl !== undefined,
            ],
            Boolean,
          )
          return defined === 1
        },
        {
          message: 'Entry must have exactly one of "serverName", "serverCommand", or "serverUrl"',
        },
      ),
  )
}
