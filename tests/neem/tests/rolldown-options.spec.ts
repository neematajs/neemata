import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { NeemPluginBuildPlan } from '../../../packages/neem/src/internal/build/plugin-plan.ts'
import { mergePluginRolldownOptions } from '../../../packages/neem/src/internal/build/plugin-plan.ts'
import { buildArtifact } from '../../../packages/neem/src/internal/build/rolldown.ts'
import {
  defineConfig,
  defineRuntime,
  normalizeNeemConfig,
} from '../../../packages/neem/src/public/config.ts'

const OUTPUT_ARRAY_ERROR =
  'Neem Rolldown output arrays are not supported; configure a single output object.'

const tempDirs: string[] = []

describe('Neem Rolldown option merging', () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    )
  })

  it('merges tuple runtime build options with shared semantics', () => {
    const basePlugin = { name: 'base' }
    const overridePlugin = { name: 'override' }
    const baseOutput = {
      chunkFileNames: 'chunks/[name].js',
      entryFileNames: 'base.js',
    }
    const overrideOutput = {
      assetFileNames: 'assets/[name][extname]',
      entryFileNames: 'worker.js',
    }
    const runtime = defineRuntime({
      worker: {
        entry: '../fixtures/basic-app.ts',
        build: {
          rolldown: {
            external: ['base-external'],
            output: baseOutput,
            plugins: [basePlugin],
          },
        },
      },
    })

    const config = defineConfig({
      runtimes: {
        api: [
          runtime,
          {
            worker: {
              build: {
                rolldown: {
                  external: ['override-external'],
                  output: overrideOutput,
                  plugins: [overridePlugin],
                },
              },
            },
          },
        ],
      },
    })
    const rolldown =
      normalizeNeemConfig(config).runtimes.api.worker.build?.rolldown

    expect(rolldown?.external).toEqual(['override-external'])
    expect(rolldown?.plugins).toEqual([basePlugin, overridePlugin])
    expect(rolldown?.output).toEqual({
      assetFileNames: 'assets/[name][extname]',
      chunkFileNames: 'chunks/[name].js',
      entryFileNames: 'worker.js',
    })
    expect(rolldown?.output).not.toBe(baseOutput)
    expect(rolldown?.output).not.toBe(overrideOutput)
  })

  it('does not add empty rolldown fields during runtime build merges', () => {
    const runtime = defineRuntime({
      worker: { entry: '../fixtures/basic-app.ts', build: {} },
    })
    const config = defineConfig({
      runtimes: { api: [runtime, { worker: { build: {} } }] },
    })

    const build = normalizeNeemConfig(config).runtimes.api.worker.build

    expect(build).toEqual({})
    expect(Object.hasOwn(build ?? {}, 'rolldown')).toBe(false)
  })

  it('merges plugin-plan options in config order', () => {
    const firstPlugin = { name: 'first-plugin' }
    const secondPlugin = { name: 'second-plugin' }
    const plans: NeemPluginBuildPlan[] = [
      {
        key: '000-first',
        index: 0,
        name: 'first',
        rolldown: {
          external: ['first-external'],
          output: {
            chunkFileNames: 'chunks/[name].js',
            entryFileNames: 'first.js',
          },
          plugins: [firstPlugin],
        },
      },
      {
        key: '001-second',
        index: 1,
        name: 'second',
        rolldown: {
          external: ['second-external'],
          output: {
            assetFileNames: 'assets/[name][extname]',
            entryFileNames: 'second.js',
          },
          plugins: [secondPlugin],
        },
      },
    ]

    const rolldown = mergePluginRolldownOptions(plans)

    expect(rolldown?.external).toEqual(['second-external'])
    expect(rolldown?.plugins).toEqual([firstPlugin, secondPlugin])
    expect(rolldown?.output).toEqual({
      assetFileNames: 'assets/[name][extname]',
      chunkFileNames: 'chunks/[name].js',
      entryFileNames: 'second.js',
    })
  })

  it('merges build-artifact plan and artifact options before defaults', async () => {
    const dir = await createTempDir()
    const entry = resolve(dir, 'entry.ts')
    const outDir = resolve(dir, 'dist')
    const order: string[] = []
    await writeFile(entry, 'export const answer = 42\n')

    const result = await buildArtifact({
      artifact: {
        id: 'merged',
        kind: 'module',
        entry,
        rolldown: {
          output: { entryFileNames: 'artifact-entry.js' },
          plugins: [
            {
              name: 'artifact-order',
              buildStart() {
                order.push('artifact')
              },
            },
          ],
        },
      },
      owner: { type: 'config' },
      rolldown: {
        output: {
          assetFileNames: 'assets/[name][extname]',
          chunkFileNames: 'chunks/[name].js',
        },
        plugins: [
          {
            name: 'plan-asset',
            buildStart(this: {
              emitFile: (file: {
                type: 'asset'
                name: string
                source: string
              }) => string
            }) {
              order.push('plan')
              this.emitFile({
                type: 'asset',
                name: 'marker.txt',
                source: 'marker',
              })
            },
          },
        ],
      },
      artifactOutDir: outDir,
      outDir,
    })

    expect(order).toEqual(['plan', 'artifact'])
    const fileNames = result.bundle?.output.map((chunk) => chunk.fileName) ?? []
    expect(fileNames).toContain('artifact-entry.js')
    expect(fileNames).toContain('assets/marker.txt')
  })

  it('rejects output arrays before Rolldown build', async () => {
    const dir = await createTempDir()
    const entry = resolve(dir, 'entry.ts')
    await writeFile(entry, 'export const answer = 42\n')

    await expect(
      buildArtifact({
        artifact: {
          id: 'array-output',
          kind: 'module',
          entry,
          rolldown: { output: [{ entryFileNames: 'entry.js' }] },
        },
        owner: { type: 'config' },
        outDir: dir,
      }),
    ).rejects.toThrow(OUTPUT_ARRAY_ERROR)
  })

  it('rejects output arrays during config and plugin-plan merges', () => {
    const runtime = defineRuntime({
      worker: { entry: '../fixtures/basic-app.ts' },
    })
    const config = defineConfig({
      runtimes: {
        api: [
          runtime,
          {
            worker: {
              build: {
                rolldown: { output: [{ entryFileNames: 'worker.js' }] },
              },
            },
          },
        ],
      },
    })

    expect(() => normalizeNeemConfig(config)).toThrow(OUTPUT_ARRAY_ERROR)
    expect(() =>
      mergePluginRolldownOptions([
        {
          key: '000-array',
          index: 0,
          name: 'array',
          rolldown: { output: [{ entryFileNames: 'plugin.js' }] },
        },
      ]),
    ).toThrow(OUTPUT_ARRAY_ERROR)
  })
})

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(resolve(tmpdir(), 'neem-rolldown-options-'))
  tempDirs.push(dir)
  return dir
}
