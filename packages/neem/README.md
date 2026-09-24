# Neem

Conventional runtime and planner lookup recognizes `.ts`, `.mts`, `.js` and
`.mjs` files.

## Runtime restart

`neem dev` builds runtime workers with Rolldown DevEngine. An edit to a worker
or its bundled dependencies stops the current runtime generation and creates
and starts the updated worker in the same thread. Neem awaits cleanup before
starting the replacement; planners and hosts keep their existing rebuild and
reload behavior. Every restart of a patched runtime, including host recovery
after a crash, first rewrites the worker output so it loads the accepted
patches.

A changed upstream list, a rejected or failed patch, a thread that was not
registered for the update, an update to a module that has not run yet (such as
one reached only through a pending dynamic `import()`), or a worker declaring
`reload: 'thread'` falls back to restarting the runtime: all of its worker
threads and its host runner start again from fresh output. Fallback logs
include the reason. Syntax errors are logged and leave the last good generation
running until the source is fixed. A restart never loads output older than the
running generation; when the latest worker output cannot be written, the
restart is deferred until the worker builds again.

Each thread reports one of three patch outcomes: `applied`; `rejected`, which
retired nothing, so the old generation keeps serving and the runtime falls back
to the restart above; or `unavailable`, when the patch failed after it began
disposing the old generation (a throwing dispose callback, an updated worker
that declares `reload: 'thread'`, a replacement that failed to start or changed
the upstream list) or the worker never answered it, so recovery restarts the
runtime from the current output at once. If
that restart fails too, the runtime stays failed and unready without ending
`neem dev` until its next successful build restarts it. A crashed watcher
restarts on its own and restarts the runtimes from its fresh build.

Modules re-executed by a patch can register `import.meta.hot.dispose(callback)`
to release module-level timers or listeners; the callback receives
`import.meta.hot.data`, which the next instance of the module sees. Only
self-accepting boundaries are supported.

Use `defineRuntimeWorker({ definition, createRuntime, reload: 'thread' })` when
every edit needs that runtime restart with fresh threads. The default is
`reload: 'generation'`; `stop()` must release the generation's resources before
its replacement can start.

`build.updates.maxPatches` limits accepted patches per thread (default `50`).
After that many patches, the next update restarts the runtime from fresh
output. Set it to `0` to restart on every update. Production workers are
created directly and their bundles contain no DevEngine instrumentation.

## Shutdown

`neem start`, `neem dev` and a built `start.js` stop within one total budget,
`lifecycle.stopTimeout` in `neem.config.ts` (milliseconds, default `15000`).
Host `stop()` hooks, runtime hosts, workers and plugins share it: each step
gets what earlier steps left over. Anything still running when the budget runs
out is terminated.

Before a worker, host runner or the host itself exits, it flushes its logger
within what is left of that budget, so asynchronous destinations keep the
shutdown logs. A crashing thread gets a best-effort flush of up to one second.

A shutdown that fails exits with a non-zero code: a cleanup step that throws,
or a worker or host runner that had to be terminated. `lifecycle.startTimeout`
(default `30000`) bounds how long a worker may take to become ready.

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
