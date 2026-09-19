import { isAbsolute, normalize } from 'node:path'

import * as z from 'zod/mini'

import type { NeemLoggerOptions } from '../../shared/types.ts'

export const NEEM_MANIFEST_SCHEMA_VERSION = 1

// Strict objects throughout: the manifest is written and read by the same
// schema version, so unknown keys mean corruption, not forward compatibility.
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
const manifestEnvSchema = z.record(z.string(), z.string())

const manifestArtifactOwnerSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('config') }),
  z.strictObject({ type: z.literal('runtime'), name: z.string() }),
])

const manifestArtifactSchema = z.strictObject({
  id: z.string(),
  kind: z.enum(['worker', 'module']),
  owner: manifestArtifactOwnerSchema,
  file: manifestPathSchema,
  outDir: manifestPathSchema,
})

const manifestLoggerSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('module'), file: manifestPathSchema }),
  z.strictObject({
    type: z.literal('options'),
    // Logger options are @nmtjs/core LoggingOptions; their shape is owned by
    // core and validated there when the logger is created.
    options: z.optional(z.custom<NeemLoggerOptions>()),
  }),
])

const manifestProxyRoutingSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('path'), name: z.optional(z.string()) }),
  z.strictObject({
    type: z.literal('subdomain'),
    name: z.optional(z.string()),
  }),
  z.strictObject({ type: z.literal('default') }),
])

const manifestRuntimeProxySchema = z.strictObject({
  routing: z.optional(manifestProxyRoutingSchema),
  sni: z.optional(z.string()),
})

const manifestProxyConfigSchema = z.strictObject({
  hostname: z.string(),
  port: z.number(),
  healthChecks: z.optional(
    z.strictObject({ interval: z.optional(z.number()) }),
  ),
  stickySessions: z.optional(
    z.strictObject({
      enabled: z.optional(z.boolean()),
      cookieName: z.optional(z.string()),
      headerName: z.optional(z.string()),
      ttlMs: z.optional(z.number()),
      maxEntries: z.optional(z.number()),
    }),
  ),
  tls: z.optional(
    z.strictObject({ keyPath: z.string(), certPath: z.string() }),
  ),
})

const manifestHealthConfigSchema = z.strictObject({
  hostname: z.optional(z.string()),
  port: z.number(),
  paths: z.optional(
    z.strictObject({
      health: z.optional(z.string()),
      ready: z.optional(z.string()),
    }),
  ),
})

const manifestRuntimeConfigSchema = z.strictObject({
  proxy: z.optional(manifestRuntimeProxySchema),
})

const manifestConfigSchema = z.strictObject({
  logger: z.optional(manifestLoggerSchema),
  env: z.optional(manifestEnvSchema),
  proxy: z.optional(manifestProxyConfigSchema),
  health: z.optional(manifestHealthConfigSchema),
  runtimes: z.record(z.string(), manifestRuntimeConfigSchema),
})

const manifestPluginSchema = z.strictObject({
  name: manifestPluginNameSchema,
  entry: z.optional(z.strictObject({ file: manifestPathSchema })),
  // Plugin options are opaque to Neem; the owning plugin validates them.
  options: z.optional(z.unknown()),
})

const manifestRuntimeSchema = z.strictObject({
  name: z.string(),
  env: z.optional(manifestEnvSchema),
  worker: z.optional(manifestArtifactSchema),
  host: manifestArtifactSchema,
  planner: manifestArtifactSchema,
})

const manifestRuntimeEntrySchema = z.strictObject({
  entry: manifestPathSchema,
  start: manifestArtifactSchema,
  worker: manifestArtifactSchema,
})

const RUNTIME_ARTIFACTS = ['worker', 'host', 'planner'] as const

export const manifestSchema = z
  .strictObject({
    schemaVersion: z.literal(NEEM_MANIFEST_SCHEMA_VERSION),
    runtime: manifestRuntimeEntrySchema,
    plugins: z.optional(z.array(manifestPluginSchema)),
    config: manifestConfigSchema,
    runtimes: z.record(z.string(), manifestRuntimeSchema),
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

      for (const artifactName of RUNTIME_ARTIFACTS) {
        const artifact = runtime[artifactName]
        if (!artifact) continue
        if (artifact.id !== artifactName) {
          payload.issues.push({
            code: 'custom',
            input: artifact.id,
            path: ['runtimes', runtimeName, artifactName, 'id'],
          })
        }
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

// The schema is the single source of truth for the manifest shape; every
// Manifest* type is derived from it so a schema change is a compile error.
export type Manifest = z.infer<typeof manifestSchema>

export function parseManifest(manifest: unknown): Manifest {
  return manifestSchema.parse(manifest)
}
