# Neem

Conventional runtime and planner lookup recognizes `.ts`, `.mts`, `.js` and
`.mjs` files.

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

## Experimental worker HMR

Enable Rolldown's native DevEngine in `neem.config.ts`:

```ts
import { defineConfig } from '@nmtjs/neem'

export default defineConfig({
  build: { experimentalDev: true },
  runtimes: ['./src/runtimes/*'],
})
```

Worker implementation edits can then update the running thread. Workers opt in
through a `NeemRuntimeHmrAdapter`, loaded by their `hmr()` method behind
`import.meta.hot`. The adapter owns how an updated definition replaces its
resources. An unsupported or rejected update rebuilds the full artifact and
restarts the runtime. Planner, host, and config changes use the existing reload
path. Vite and Nuxt keep their own application HMR.

Both `@nmtjs/workflows/neem` and `@nmtjs/workflows/effect/neem` provide this
adapter: they stop the old worker generation, dispose its resources, and start
the updated generation in the same thread. Keep planner imports limited to the
thread layout so implementation edits do not also rebuild the planner.

Normal development and production builds remove the HMR bootstrap and guarded
adapter imports. `experimentalDev` affects only `neem dev`.
