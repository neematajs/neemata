#!/usr/bin/env -S node --enable-source-maps --expose-gc
// env -S is required for multi-flag shebangs on Linux. --expose-gc backs the
// manual gc() nudge in the dev watcher (internal/build/compiler.ts).
import { mainCommand } from '@nmtjs/neem/cli'
import { runMain } from 'citty'

await runMain(mainCommand, {})
