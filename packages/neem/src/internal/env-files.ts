import * as NodeFileSystem from '@effect/platform-node/NodeFileSystem'
import * as ConfigProvider from 'effect/ConfigProvider'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'

/** Plain dotenv parsing is first-party; dotenvx expansion and encrypted files retain their decoder. */
export const loadEnvFiles = (paths: readonly string[]) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const contents = yield* Effect.forEach(paths, (path) =>
      fs
        .readFileString(path)
        .pipe(
          Effect.mapError(
            (error) =>
              new Error(
                `Unable to load environment file [${path}]: ${String(error)}`,
                { cause: error },
              ),
          ),
        ),
    )
    if (
      contents.some((content) =>
        /encrypted:|DOTENV_PUBLIC_KEY|\$/.test(content),
      )
    ) {
      yield* Effect.promise(async () => {
        // dotenvx is CommonJS; use its default export for expansion and decryption.
        const { default: dotenvx } = await import('@dotenvx/dotenvx')
        dotenvx.config({ path: [...paths], quiet: true, strict: true })
      })
      return
    }
    for (const content of contents) {
      const provider = ConfigProvider.fromDotEnvContents(content, {
        expandVariables: true,
        preserveEmptyStrings: true,
      })
      const visit = (
        path: ConfigProvider.Path,
      ): Effect.Effect<void, ConfigProvider.SourceError> =>
        Effect.gen(function* () {
          const node = yield* provider.load(path)
          if (!node) return
          const key = path.join('_')
          if (
            path.length &&
            node.value !== undefined &&
            process.env[key] === undefined
          )
            process.env[key] = node.value
          const keys =
            node._tag === 'Record'
              ? [...node.keys]
              : node._tag === 'Array'
                ? Array.from({ length: node.length }, (_, index) => index)
                : []
          for (const key of keys) yield* visit([...path, key])
        })
      yield* visit([])
    }
  }).pipe(Effect.provide(NodeFileSystem.layer))
