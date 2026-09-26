import { isAbsolute, normalize } from 'node:path'

import * as z from 'zod/mini'

import type { Manifest } from '../manifest/manifest.ts'

export const NEEM_MANIFEST_SCHEMA_VERSION = 3

// Strict objects throughout: the manifest is written and read by the same
// schema version, so unknown keys mean corruption, not forward compatibility.
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
  z.strictObject({ type: z.literal('config') }),
  z.strictObject({ type: z.literal('runtime'), name: stringSchema }),
])

const createManifestArtifactSchema = (id: z.ZodMiniType = stringSchema) =>
  z.strictObject({
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

const manifestLoggerSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('module'), file: manifestPathSchema }),
  z.strictObject({
    type: z.literal('options'),
    // NeemLoggerOptions includes Pino-specific settings; the manifest only
    // checks the surrounding shape and passes these to logger construction.
    options: z.optional(z.unknown()),
  }),
])

const manifestProxyRoutingSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('path'), name: z.optional(stringSchema) }),
  z.strictObject({
    type: z.literal('subdomain'),
    name: z.optional(stringSchema),
  }),
  z.strictObject({ type: z.literal('default') }),
])

const manifestProxyLimitSchema = z.optional(
  z.nullable(z.number().check(z.int(), z.gt(0))),
)

const manifestRuntimeProxySchema = z.strictObject({
  routing: z.optional(manifestProxyRoutingSchema),
  sni: z.optional(stringSchema),
  maxRequestBodySize: manifestProxyLimitSchema,
})

const manifestProxyConfigSchema = z.strictObject({
  hostname: stringSchema,
  port: z.number(),
  healthChecks: z.optional(
    z.strictObject({ interval: z.optional(z.number()) }),
  ),
  stickySessions: z.optional(
    z.strictObject({
      enabled: z.optional(z.boolean()),
      cookieName: z.optional(stringSchema),
      headerName: z.optional(stringSchema),
      ttlMs: z.optional(z.number()),
      maxEntries: z.optional(z.number()),
    }),
  ),
  limits: z.optional(
    z.nullable(
      z.strictObject({
        maxUriSize: manifestProxyLimitSchema,
        maxRequestHeaders: manifestProxyLimitSchema,
        maxSingleHeaderSize: manifestProxyLimitSchema,
        maxRequestHeaderSize: manifestProxyLimitSchema,
        maxRequestBodySize: manifestProxyLimitSchema,
      }),
    ),
  ),
  tls: z.optional(
    z.strictObject({ keyPath: stringSchema, certPath: stringSchema }),
  ),
})

const manifestHealthConfigSchema = z.strictObject({
  hostname: z.optional(stringSchema),
  port: z.number(),
  paths: z.optional(
    z.strictObject({
      health: z.optional(stringSchema),
      ready: z.optional(stringSchema),
    }),
  ),
})

const timeoutMsSchema = z.number().check(z.int(), z.gt(0))

const manifestLifecycleConfigSchema = z.strictObject({
  stopTimeout: z.optional(timeoutMsSchema),
  startTimeout: z.optional(timeoutMsSchema),
})

const manifestRuntimeConfigSchema = z.strictObject({
  proxy: z.optional(manifestRuntimeProxySchema),
})

const manifestConfigSchema = z.strictObject({
  build: z.optional(
    z.strictObject({
      updates: z.optional(
        z.strictObject({
          maxPatches: z.optional(z.number().check(z.int(), z.gte(0))),
        }),
      ),
    }),
  ),
  logger: z.optional(manifestLoggerSchema),
  env: z.optional(manifestEnvSchema),
  proxy: z.optional(manifestProxyConfigSchema),
  health: z.optional(manifestHealthConfigSchema),
  lifecycle: z.optional(manifestLifecycleConfigSchema),
  runtimes: z.record(stringSchema, manifestRuntimeConfigSchema),
})

const manifestPluginSchema = z.strictObject({
  name: manifestPluginNameSchema,
  entry: z.optional(z.strictObject({ file: manifestPathSchema })),
  // Plugin options are opaque to Neem; the owning plugin validates them.
  options: z.optional(z.unknown()),
})

const manifestRuntimeSchema = z.strictObject({
  name: stringSchema,
  env: z.optional(manifestEnvSchema),
  worker: z.optional(manifestWorkerArtifactSchema),
  host: manifestHostArtifactSchema,
  planner: manifestPlannerArtifactSchema,
})

const manifestRuntimeEntrySchema = z.strictObject({
  entry: manifestPathSchema,
  start: manifestArtifactSchema,
  worker: manifestArtifactSchema,
  runner: manifestArtifactSchema,
})

export const manifestSchema = z
  .strictObject({
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
