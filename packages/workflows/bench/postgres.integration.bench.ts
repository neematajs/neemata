import * as Schema from 'effect/Schema'
import { test } from 'vitest'

import type { WorkflowPostgresConnection } from '../src/adapters/postgres.ts'
import type { WorkflowRuntimeClient } from '../src/runtime/index.ts'
import { defineWorkflow } from '../src/effect/index.ts'
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
  input: Schema.Struct({ sequence: Schema.Number, text: Schema.String }),
  output: Schema.Struct({ text: Schema.String }),
}).build()

requireServiceEnv(postgresTarget)

test.skipIf(!postgresTarget.url)(
  'Postgres workflow persistence',
  async ({ bench }) => {
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

    await bench(
      `persists ${startsPerSample} workflow starts`,
      {
        beforeAll: setup,
        afterAll: (mode) => {
          if (mode === 'run') return teardown()
        },
      },
      async () => {
        await Promise.all(inputs.map((input) => client!.start(workflow, input)))
      },
    ).run(benchmarkOptions)
  },
)
