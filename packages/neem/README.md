# Neem

Conventional runtime and planner lookup recognizes `.ts`, `.mts`, `.js` and
`.mjs` files.

## Worker HMR

`neem dev` builds runtime workers with Rolldown DevEngine. An edit to a worker
or its bundled dependencies stops the current runtime generation and creates
and starts the updated worker in the same thread. Neem awaits cleanup before
starting the replacement; planners and hosts keep their existing rebuild and
reload behavior.

A changed upstream list, a rejected or failed patch, or a worker declaring
`reload: 'thread'` falls back to a full thread restart. Neem refreshes the full
bundle before restarting, including when a planner or host changes after an
accepted patch. Syntax errors are logged and leave the last good generation
running until the source is fixed. Fallback logs include the reason.

Use `defineRuntimeWorker({ definition, createRuntime, reload: 'thread' })` when
the worker requires a fresh thread on every edit. The default is
`reload: 'generation'`; `stop()` must release the generation's resources before
its replacement can start.

`build.hmr.maxPatches` limits accepted patches per thread (default `50`). After
that many patches, the next update restarts threads from fresh output. Set it
to `0` to restart on every update. Production workers are created directly and
their bundles contain no DevEngine instrumentation.

## Development environment files

Load an environment file before evaluating `neem.config.ts` and starting workers:

```sh
neem dev --env-files ../../.env
```

For multiple files, use a comma-separated list:

```sh
neem dev --env-files .env.local,../../.env
```

Paths are relative to the working directory, including when using `--config`.
Existing process environment variables take precedence, followed by the first
file defining a variable. Files are loaded using
[@dotenvx/dotenvx](https://dotenvx.com/docs/sdk/config), which supports variable
expansion and encrypted values. Missing files or decryption errors fail startup.

Files are loaded once; restart `neem dev` after changing them. Without
`--env-files`, Neem does not load environment files automatically. This option is
only available on `dev`; `build` and `start` use their existing environment.

When launched with Bun, Bun loads environment files before Neem starts. Those
values count as existing process variables and take precedence over `--env-files`.
Bun also loads `.env.local` in development, but skips it with `NODE_ENV=test`.

`NeemConfig.env` remains an inline environment map included in the manifest.
