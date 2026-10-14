import { isAbsolute, normalize } from 'node:path'

import * as Schema from 'effect/Schema'

import type { Manifest } from '../manifest/manifest.ts'

export const NEEM_MANIFEST_SCHEMA_VERSION = 5

// Strict objects throughout: the manifest is written and read by the same
// schema version, so unknown keys mean corruption, not forward compatibility.
const stringSchema = Schema.String
const manifestPathSchema = Schema.String.check(
  Schema.makeFilter(
    (path) =>
      (path.length > 0 &&
        !isAbsolute(path) &&
        !normalize(path).startsWith('..')) ||
      'Expected a non-empty relative path inside the output directory',
  ),
)
const manifestPluginNameSchema = Schema.String.check(
  Schema.makeFilter((name) => name.trim().length > 0),
)
const manifestEnvSchema = Schema.Record(stringSchema, stringSchema)

const manifestArtifactOwnerSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal('config') }),
  Schema.Struct({ type: Schema.Literal('runtime'), name: stringSchema }),
])

const createManifestArtifactSchema = (
  id: Schema.Codec<string> = stringSchema,
) =>
  Schema.Struct({
    id,
    kind: Schema.Literals(['worker', 'module']),
    owner: manifestArtifactOwnerSchema,
    file: manifestPathSchema,
    outDir: manifestPathSchema,
  })

const manifestArtifactSchema = createManifestArtifactSchema()

const manifestWorkerArtifactSchema = createManifestArtifactSchema(
  Schema.Literal('worker'),
)
const manifestHostArtifactSchema = createManifestArtifactSchema(
  Schema.Literal('host'),
)
const manifestPlannerArtifactSchema = createManifestArtifactSchema(
  Schema.Literal('planner'),
)

const manifestLoggerSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal('module'), file: manifestPathSchema }),
  Schema.Struct({
    type: Schema.Literal('options'),
    // NeemLoggerOptions includes Pino-specific settings; the manifest only
    // checks the surrounding shape and passes these to logger construction.
    options: Schema.optional(Schema.Unknown),
  }),
])

const manifestProxyRoutingSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal('path'),
    name: Schema.optional(stringSchema),
  }),
  Schema.Struct({
    type: Schema.Literal('subdomain'),
    name: Schema.optional(stringSchema),
  }),
  Schema.Struct({ type: Schema.Literal('default') }),
])

const manifestProxyLimitSchema = Schema.optional(
  Schema.NullOr(Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0))),
)

const manifestRuntimeProxySchema = Schema.Struct({
  routing: Schema.optional(manifestProxyRoutingSchema),
  sni: Schema.optional(stringSchema),
  maxRequestBodySize: manifestProxyLimitSchema,
})

const manifestServerConfigSchema = Schema.Struct({
  hostname: Schema.optional(stringSchema),
  port: Schema.optional(Schema.Number),
  health: Schema.optional(
    Schema.Struct({
      paths: Schema.optional(
        Schema.Struct({
          health: Schema.optional(stringSchema),
          ready: Schema.optional(stringSchema),
        }),
      ),
    }),
  ),
  upstreamChecks: Schema.optional(
    Schema.Struct({ interval: Schema.optional(Schema.Number) }),
  ),
  stickySessions: Schema.optional(
    Schema.Struct({
      enabled: Schema.optional(Schema.Boolean),
      cookieName: Schema.optional(stringSchema),
      headerName: Schema.optional(stringSchema),
      ttlMs: Schema.optional(Schema.Number),
      maxEntries: Schema.optional(Schema.Number),
    }),
  ),
  limits: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        maxUriSize: manifestProxyLimitSchema,
        maxRequestHeaders: manifestProxyLimitSchema,
        maxSingleHeaderSize: manifestProxyLimitSchema,
        maxRequestHeaderSize: manifestProxyLimitSchema,
        maxRequestBodySize: manifestProxyLimitSchema,
      }),
    ),
  ),
  tls: Schema.optional(
    Schema.Struct({ keyPath: stringSchema, certPath: stringSchema }),
  ),
})

const timeoutMsSchema = Schema.Number.check(
  Schema.isInt(),
  Schema.isGreaterThan(0),
)

const manifestLifecycleConfigSchema = Schema.Struct({
  stopTimeout: Schema.optional(timeoutMsSchema),
  startTimeout: Schema.optional(timeoutMsSchema),
})

const manifestRuntimeConfigSchema = Schema.Struct({
  proxy: Schema.optional(manifestRuntimeProxySchema),
})

const manifestConfigSchema = Schema.Struct({
  build: Schema.optional(
    Schema.Struct({
      updates: Schema.optional(
        Schema.Struct({
          maxPatches: Schema.optional(
            Schema.Number.check(
              Schema.isInt(),
              Schema.isGreaterThanOrEqualTo(0),
            ),
          ),
        }),
      ),
    }),
  ),
  logger: Schema.optional(manifestLoggerSchema),
  env: Schema.optional(manifestEnvSchema),
  server: Schema.optional(manifestServerConfigSchema),
  lifecycle: Schema.optional(manifestLifecycleConfigSchema),
  runtimes: Schema.Record(stringSchema, manifestRuntimeConfigSchema),
})

const manifestPluginSchema = Schema.Struct({
  name: manifestPluginNameSchema,
  entry: Schema.optional(Schema.Struct({ file: manifestPathSchema })),
  // Plugin options are opaque to Neem; the owning plugin validates them.
  options: Schema.optional(Schema.Unknown),
})

const manifestRuntimeSchema = Schema.Struct({
  name: stringSchema,
  env: Schema.optional(manifestEnvSchema),
  worker: Schema.optional(manifestWorkerArtifactSchema),
  host: manifestHostArtifactSchema,
  planner: manifestPlannerArtifactSchema,
})

const manifestRuntimeEntrySchema = Schema.Struct({
  entry: manifestPathSchema,
  start: manifestArtifactSchema,
  worker: manifestArtifactSchema,
  runner: manifestArtifactSchema,
})

export const manifestSchema = Schema.Struct({
  schemaVersion: Schema.Literal(NEEM_MANIFEST_SCHEMA_VERSION),
  runtime: manifestRuntimeEntrySchema,
  plugins: Schema.optional(Schema.Array(manifestPluginSchema)),
  config: manifestConfigSchema,
  runtimes: Schema.Record(stringSchema, manifestRuntimeSchema),
}).check(
  Schema.makeFilter((manifest) => {
    for (const [runtimeName, runtime] of Object.entries(manifest.runtimes)) {
      if (runtime.name !== runtimeName)
        return `runtimes.${runtimeName}.name must match its key`
      for (const artifactName of ['worker', 'host', 'planner'] as const) {
        const artifact = runtime[artifactName]
        if (
          artifact &&
          (artifact.owner.type !== 'runtime' ||
            artifact.owner.name !== runtimeName)
        )
          return `runtimes.${runtimeName}.${artifactName}.owner must match its runtime`
      }
    }
    return true
  }),
)

export function parseManifest(manifest: unknown): Manifest {
  return Schema.decodeUnknownSync(manifestSchema, {
    onExcessProperty: 'error',
  })(manifest) as Manifest
}
