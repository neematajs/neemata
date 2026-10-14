import type { LoadRuntimeSnapshotOptions } from '@nmtjs/neem/internal/host/bootstrap'
import type { Manifest } from '@nmtjs/neem/internal/manifest/manifest'
import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import { resolveManifestLogger } from '@nmtjs/neem/internal/logger'
import {
  assertManifestFilesExist,
  selectManifestRuntimes,
} from '@nmtjs/neem/internal/manifest/manifest'
import { createRuntimeSnapshot } from '@nmtjs/neem/internal/manifest/snapshot'
import { normalizeError } from '@nmtjs/neem/internal/utils'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Schema from 'effect/Schema'

import {
  applyHostConfigEnvOverrides,
  formatAppliedEnvOverride,
} from './env-config.ts'
import { FLAVOR_NAME } from './flavor-name.ts'
import { attempt } from './lifetime.ts'
import {
  manifestSchema,
  NEEM_MANIFEST_SCHEMA_VERSION,
} from './manifest-schema.ts'

export const loadSnapshot = (options: LoadRuntimeSnapshotOptions) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const content = yield* fs.readFileString(options.manifestFile)
    const json: unknown = yield* Effect.try({
      try: () => JSON.parse(content),
      catch: normalizeError,
    })
    if (
      typeof json !== 'object' ||
      json === null ||
      !('schemaVersion' in json) ||
      json.schemaVersion !== NEEM_MANIFEST_SCHEMA_VERSION
    )
      return yield* Effect.fail(
        new Error(
          `Manifest schema version mismatch in [${options.manifestFile}]; rebuild the output`,
        ),
      )
    const parsed = yield* Schema.decodeUnknownEffect(manifestSchema, {
      onExcessProperty: 'error',
    })(json)
    const manifest = yield* Effect.try({
      try: () => selectManifestRuntimes(parsed as Manifest, options.runtimes),
      catch: normalizeError,
    })
    const flavor = manifest.runtime.flavor ?? 'neem'
    if (flavor !== FLAVOR_NAME)
      return yield* Effect.fail(
        new Error(
          `Build uses host [${flavor}]; start it with [${flavor}], not [${FLAVOR_NAME}]`,
        ),
      )
    yield* attempt(() => assertManifestFilesExist(options.outDir, manifest))
    const logger =
      options.logger ??
      (yield* attempt(() =>
        resolveManifestLogger(manifest.config.logger, options),
      ))
    const { config, applied } = yield* Effect.try({
      try: () =>
        applyHostConfigEnvOverrides(manifest.config, {
          ...process.env,
          ...options.env,
        }),
      catch: normalizeError,
    })
    for (const override of applied)
      logger.info(formatAppliedEnvOverride(override))
    return createRuntimeSnapshot({
      ...options,
      manifest,
      logger,
      resolvedConfig: config,
    })
  }).pipe(Effect.provide(NodeFileSystem.layer), Effect.mapError(normalizeError))
