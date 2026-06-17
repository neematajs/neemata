import { isAbsolute, normalize } from 'node:path'

import * as z from 'zod/mini'

import type { Manifest } from '../manifest/manifest.ts'

export const NEEM_MANIFEST_SCHEMA_VERSION = 1

const stringSchema = z.string()
const manifestPathSchema = z
  .string()
  .check(
    z.refine(
      (path) =>
        path.length > 0 &&
        !isAbsolute(path) &&
        !normalize(path).startsWith('..'),
    ),
  )
const manifestPluginNameSchema = z
  .string()
  .check(z.refine((name) => name.trim().length > 0))
const manifestEnvSchema = z.record(stringSchema, stringSchema)

const manifestArtifactOwnerSchema = z.discriminatedUnion('type', [
  z.looseObject({ type: z.literal('config') }),
  z.looseObject({ type: z.literal('runtime'), name: stringSchema }),
])

const createManifestArtifactSchema = (id: z.ZodMiniType = stringSchema) =>
  z.looseObject({
    id,
    kind: z.enum(['worker', 'module']),
    owner: manifestArtifactOwnerSchema,
    file: manifestPathSchema,
    outDir: manifestPathSchema,
  })

const manifestArtifactSchema = createManifestArtifactSchema()

const manifestWorkerArtifactSchema = createManifestArtifactSchema(
  z.literal('worker'),
)
const manifestHostArtifactSchema = createManifestArtifactSchema(
  z.literal('host'),
)
const manifestPlannerArtifactSchema = createManifestArtifactSchema(
  z.literal('planner'),
)

const manifestRuntimeEntryWorkerArtifactSchema = z.looseObject({
  id: stringSchema,
  kind: z.enum(['worker', 'module']),
  owner: manifestArtifactOwnerSchema,
  file: manifestPathSchema,
  outDir: manifestPathSchema,
})

const manifestLoggerSchema = z.discriminatedUnion('type', [
  z.looseObject({ type: z.literal('module'), file: manifestPathSchema }),
  z.looseObject({
    type: z.literal('options'),
    options: z.optional(z.unknown()),
  }),
])

const manifestRuntimeConfigSchema = z.looseObject({
  static: z.optional(z.literal(true)),
})

const manifestConfigSchema = z.looseObject({
  logger: z.optional(manifestLoggerSchema),
  env: z.optional(manifestEnvSchema),
  proxy: z.optional(z.unknown()),
  health: z.optional(z.unknown()),
  runtimes: z.record(stringSchema, manifestRuntimeConfigSchema),
})

const manifestPluginSchema = z.looseObject({
  name: manifestPluginNameSchema,
  entry: z.optional(z.looseObject({ file: manifestPathSchema })),
  options: z.optional(z.unknown()),
})

const manifestRuntimeSchema = z.looseObject({
  name: stringSchema,
  env: z.optional(manifestEnvSchema),
  worker: z.optional(manifestWorkerArtifactSchema),
  host: manifestHostArtifactSchema,
  planner: manifestPlannerArtifactSchema,
})

const manifestRuntimeEntrySchema = z.looseObject({
  entry: manifestPathSchema,
  start: manifestArtifactSchema,
  worker: manifestRuntimeEntryWorkerArtifactSchema,
})

export const manifestSchema = z
  .looseObject({
    schemaVersion: z.literal(NEEM_MANIFEST_SCHEMA_VERSION),
    runtime: manifestRuntimeEntrySchema,
    plugins: z.optional(z.array(manifestPluginSchema)),
    config: manifestConfigSchema,
    runtimes: z.record(stringSchema, manifestRuntimeSchema),
  })
  .check((payload) => {
    for (const [runtimeName, runtime] of Object.entries(
      payload.value.runtimes,
    )) {
      if (runtime.name !== runtimeName) {
        payload.issues.push({
          code: 'custom',
          input: runtime.name,
          path: ['runtimes', runtimeName, 'name'],
        })
      }

      for (const artifactName of ['worker', 'host', 'planner'] as const) {
        const artifact = runtime[artifactName]
        if (!artifact) continue
        if (
          artifact.owner.type !== 'runtime' ||
          artifact.owner.name !== runtimeName
        ) {
          payload.issues.push({
            code: 'custom',
            input: artifact.owner,
            path: ['runtimes', runtimeName, artifactName, 'owner'],
          })
        }
      }
    }
  })

export function parseManifest(manifest: unknown): Manifest {
  return manifestSchema.parse(manifest) as Manifest
}
