import { t } from '@nmtjs/type'
import { bench, describe } from 'vitest'

import type { WorkflowPostgresConnection } from '../src/adapters/postgres.ts'
import type { WorkflowRuntimeClient } from '../src/runtime/index.ts'
import { defineWorkflow } from '../src/index.ts'
import { createWorkflowRuntimeClient } from '../src/runtime/index.ts'
import {
  createPostgresWorkflowHarness,
  createTestName,
  postgresTarget,
  requireServiceEnv,
  type PostgresWorkflowHarness,
} from '../tests/integration/helpers.ts'

const startsPerSample = 8
const inputs = Array.from({ length: startsPerSample }, (_, index) => ({
  sequence: index,
  text: 'postgres-benchmark',
}))
const benchmarkOptions = {
  iterations: 600,
  time: 0,
  warmupIterations: 50,
  warmupTime: 0,
}
const workflow = defineWorkflow({
  name: createTestName('postgres-benchmark'),
  input: t.object({ sequence: t.number(), text: t.string() }),
  output: t.object({ text: t.string() }),
}).build()

requireServiceEnv(postgresTarget)

describe.skipIf(!postgresTarget.url)('Postgres workflow persistence', () => {
  let harness: PostgresWorkflowHarness | undefined
  let client: WorkflowRuntimeClient<WorkflowPostgresConnection> | undefined

  async function setup() {
    if (harness) return
    harness = await createPostgresWorkflowHarness(postgresTarget)
    client = createWorkflowRuntimeClient(harness.runtime)
  }

  async function teardown() {
    const runningHarness = harness
    harness = undefined
    client = undefined
    await runningHarness?.cleanup()
  }

  bench(
    `persists ${startsPerSample} workflow starts`,
    async () => {
      await Promise.all(inputs.map((input) => client!.start(workflow, input)))
    },
    {
      ...benchmarkOptions,
      setup,
      teardown: (_task, mode) => {
        if (mode === 'run') return teardown()
      },
    },
  )
})
