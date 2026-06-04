import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import * as planner from '../src/neem/planner.ts'
import * as runtime from '../src/neem/runtime.ts'
import * as worker from '../src/neem/worker.ts'

const testDir = dirname(fileURLToPath(import.meta.url))

describe('Neem application entrypoints', () => {
  it('keeps runtime, planner, and worker APIs in separate subpath files', () => {
    expect(existsSync(join(testDir, '../src/neem.ts'))).toBe(false)

    expect(runtime.createNeemataRuntime).toEqual(expect.any(Function))
    expect(planner.defineNeemataPlanner).toEqual(expect.any(Function))
    expect(worker.defineNeemataWorker).toEqual(expect.any(Function))
    expect(worker.NeemataApplicationRuntime).toEqual(expect.any(Function))
  })
})
