import type {
  NeemResolvedArtifact,
  NeemRuntimePlan,
} from '../../shared/types.ts'
import type { RuntimeSnapshot } from '../manifest/snapshot.ts'
import type { ThreadPlan } from './thread.ts'
import { normalizeError } from '../utils.ts'

export function resolveRuntimeArtifact(
  snapshot: RuntimeSnapshot,
  runtimeName: string,
  artifactId: string,
): NeemResolvedArtifact | undefined {
  return snapshot.artifacts.resolveFor(
    { type: 'runtime', name: runtimeName },
    artifactId,
  )
}

export function resolveRequiredRuntimeArtifact(
  snapshot: RuntimeSnapshot,
  runtimeName: string,
  artifactId: string,
): NeemResolvedArtifact {
  const artifact = resolveRuntimeArtifact(snapshot, runtimeName, artifactId)
  if (!artifact) {
    throw new Error(
      `Runtime [${runtimeName}] artifact [${artifactId}] is missing`,
    )
  }
  return artifact
}

export function resolveThreadTopology(options: {
  snapshot: RuntimeSnapshot
  runtimeName: string
  plan: NeemRuntimePlan | undefined
}): readonly ThreadPlan[] {
  const workerArtifact = resolveRuntimeArtifact(
    options.snapshot,
    options.runtimeName,
    'worker',
  )
  const workers = options.plan?.workers ?? []
  const plans = normalizePlannedWorkers(options.runtimeName, workers)

  if (plans.length === 0) return []
  if (!workerArtifact) {
    throw new Error(
      `Runtime [${options.runtimeName}] planned workers but has no worker artifact`,
    )
  }

  return plans.map((plan) => ({
    name: plan.name,
    artifact: workerArtifact,
    data: plan.data,
  }))
}

function normalizePlannedWorkers(
  runtimeName: string,
  workers: unknown,
): readonly { name: string; data: unknown }[] {
  if (Array.isArray(workers)) {
    return workers.map((data, index) => {
      const name = `${runtimeName}:${index}`
      return { name, data: cloneWorkerData(runtimeName, name, data) }
    })
  }

  if (!isGroupedWorkerPlan(workers)) {
    throw new Error(
      `Runtime [${runtimeName}] planner workers must be an array or record of arrays`,
    )
  }

  return Object.entries(workers).flatMap(([group, groupWorkers]) =>
    groupWorkers.map((data, index) => {
      const name = `${runtimeName}:${group}:${index}`
      return { name, data: cloneWorkerData(runtimeName, name, data) }
    }),
  )
}

function isGroupedWorkerPlan(
  workers: unknown,
): workers is Record<string, readonly unknown[]> {
  if (typeof workers !== 'object' || workers === null) return false
  return Object.values(workers).every((group) => Array.isArray(group))
}

// Cloning here both validates the planner data and detaches it from the
// planner's object graph before it crosses the thread boundary.
function cloneWorkerData(
  runtimeName: string,
  workerName: string,
  data: unknown,
): unknown {
  try {
    return structuredClone(data)
  } catch (error) {
    throw new Error(
      `Runtime [${runtimeName}] worker [${workerName}] data must be structured-cloneable`,
      { cause: normalizeError(error) },
    )
  }
}
