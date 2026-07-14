import type { RootActionOptions } from '../assembly/types.js'
import { RootActionCompleted } from './rootActionPipeline.js'
import { prepareRootAction } from './prepareRootAction.js'
import { initializeRootRuntime } from './initializeRootRuntime.js'
import { loadRootResources } from './loadRootResources.js'
import { buildRootSession } from './buildRootSession.js'

export async function rootAction(
  prompt: string | undefined,
  options: RootActionOptions,
): Promise<void> {
  try {
    const stage0 = await prepareRootAction(prompt, options)
    const stage1 = await initializeRootRuntime(stage0)
    const stage2 = await loadRootResources(stage1)
    await buildRootSession(stage2)
  } catch (error) {
    if (error instanceof RootActionCompleted) return
    throw error
  }
}
