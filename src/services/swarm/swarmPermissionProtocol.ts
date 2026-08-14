import { z } from 'zod/v4'
import { lazySchema } from '../../utils/lazySchema.js'
import type { PermissionUpdate } from 'src/types/permissions.js'

export const SwarmPermissionRequestSchema = lazySchema(() =>
  z.object({
    id: z.string(),
    workerId: z.string(),
    workerName: z.string(),
    workerColor: z.string().optional(),
    teamName: z.string(),
    toolName: z.string(),
    toolUseId: z.string(),
    description: z.string(),
    input: z.record(z.string(), z.unknown()),
    permissionSuggestions: z.array(z.unknown()),
    status: z.enum(['pending', 'approved', 'rejected']),
    resolvedBy: z.enum(['worker', 'leader']).optional(),
    resolvedAt: z.number().optional(),
    feedback: z.string().optional(),
    updatedInput: z.record(z.string(), z.unknown()).optional(),
    permissionUpdates: z.array(z.unknown()).optional(),
    createdAt: z.number(),
  }),
)

export type SwarmPermissionRequest = z.infer<ReturnType<typeof SwarmPermissionRequestSchema>>

export type PermissionResolutionRecord = {
  decision: 'approved' | 'rejected'
  resolvedBy: 'worker' | 'leader'
  feedback?: string
  updatedInput?: Record<string, unknown>
  permissionUpdates?: PermissionUpdate[]
}
