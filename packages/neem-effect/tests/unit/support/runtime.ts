import { fileURLToPath } from 'node:url'

import type {
  Manifest,
  ManifestArtifact,
} from '@nmtjs/neem/internal/manifest/manifest'
import { createRuntimeSnapshot } from '@nmtjs/neem/internal/manifest/snapshot'
import * as Effect from 'effect/Effect'
import { pino } from 'pino'

import type { AppWorkerData } from '../fixtures/app.worker.ts'
import { createHostHooks } from '../../../src/internal/hooks.ts'
import { RuntimeSupervisor } from '../../../src/internal/runtime.ts'
import { WorkerRegistry } from '../../../src/internal/transport.ts'

const path = (relative: string) =>
  fileURLToPath(new URL(relative, import.meta.url))

const artifact = (id: string, file: string): ManifestArtifact => ({
  id,
  kind: id === 'worker' ? 'worker' : 'module',
  owner: { type: 'runtime', name: 'app' },
  file: path(file),
  outDir: path('../fixtures'),
})

/**
 * A supervisor for runtime `app`, running the package's own worker and runner
 * entries from source against the fixtures, with no build in between.
 */
export function createSupervisor(options: {
  plan: readonly AppWorkerData[]
  stopTimeout?: number
  recoveryAttempts?: number
  prepareRecovery?: () => Promise<void>
}) {
  const manifest: Manifest = {
    schemaVersion: 4,
    runtime: {
      flavor: 'neem-effect',
      entry: 'start.js',
      start: artifact('start', '../../../src/standalone/entry.ts'),
      worker: artifact('worker-entry', '../../../src/worker/entry.ts'),
      runner: artifact('host-runner-entry', '../../../src/runner/entry.ts'),
    },
    config: {
      lifecycle: { stopTimeout: options.stopTimeout ?? 5_000 },
      runtimes: { app: {} },
    },
    runtimes: {
      app: {
        name: 'app',
        worker: artifact('worker', '../fixtures/app.worker.ts'),
        host: artifact('host', '../fixtures/host.ts'),
        planner: artifact('planner', '../fixtures/planner.ts'),
      },
    },
  }
  const snapshot = createRuntimeSnapshot({
    mode: 'production',
    outDir: path('../fixtures'),
    env: { NEEM_EFFECT_TEST_PLAN: JSON.stringify(options.plan) },
    manifest,
    logger: pino({ enabled: false }),
  })
  const registry = new WorkerRegistry()
  const failures: Error[] = []
  let recovered = 0
  const supervisor = new RuntimeSupervisor({
    context: { hooks: createHostHooks(), registry },
    snapshot,
    runtimeName: 'app',
    recovery: { attempts: options.recoveryAttempts ?? 0, delayMs: 0 },
    prepareRecovery: options.prepareRecovery,
    onFailure: (error) => failures.push(error),
    onRecovered: () => recovered++,
    onUpstreamsChange: () => Effect.void,
    onStateChange: () => {},
  })
  return {
    snapshot,
    supervisor,
    registry,
    failures,
    recovered: () => recovered,
  }
}

/** Records what the fixture workers report, in order. */
export function listenToWorkers() {
  const events: string[] = []
  const channel = new BroadcastChannel('neem-effect-unit')
  channel.onmessage = (message) => {
    const { id, event } = (message as { data: { id: string; event: string } })
      .data
    events.push(`${id}:${event}`)
  }
  return {
    events,
    waitFor: async (event: string, timeoutMs = 10_000) => {
      const until = Date.now() + timeoutMs
      while (!events.includes(event)) {
        if (Date.now() > until)
          throw new Error(`No [${event}] in ${events.join(', ')}`)
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
    },
    close: () => channel.close(),
  }
}
