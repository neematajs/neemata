#!/usr/bin/env -S node --expose-gc
// env -S passes the flag on Linux. --expose-gc backs the manual gc() nudge in
// the shared dev watcher. Source maps are not a flag here: `dev` and
// `preview` enable them unless the user's own Node flag says otherwise, and
// `start` keeps Node's default.
import { runMain } from '@effect/platform-node/NodeRuntime'
import { runCli } from '@nmtjs/neem/cli'
import * as Cause from 'effect/Cause'
import * as CliError from 'effect/cli/CliError'
import * as Console from 'effect/Console'
import * as Effect from 'effect/Effect'
import * as Runtime from 'effect/Runtime'

import pkg from '../package.json' with { type: 'json' }

const program = runCli(process.argv.slice(2), pkg.version).pipe(
  Effect.tapCause((cause) => {
    // CLI parse errors already have formatted diagnostics; runtime failures
    // go to stderr so stdout stays useful for help and shell completions.
    if (
      Cause.hasInterruptsOnly(cause) ||
      CliError.isCliError(Cause.squash(cause))
    )
      return Effect.void
    return Console.error(Cause.pretty(cause))
  }),
)

runMain(program, {
  disableErrorReporting: true,
  teardown(exit, onExit) {
    // A requested daemon shutdown is successful only if all cleanup succeeded.
    if (exit._tag === 'Failure' && Cause.hasInterruptsOnly(exit.cause))
      onExit(0)
    else Runtime.defaultTeardown(exit, onExit)
  },
})
