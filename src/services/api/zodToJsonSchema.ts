import { toJSONSchema, type ZodTypeAny } from 'zod/v4'

export function zodToJsonSchema(schema: ZodTypeAny): Record<string, unknown> {
  return toJSONSchema(schema)
}
