#!/usr/bin/env bun --no-clear-screen
import { run } from './cli'

// workaround: bun run --bun doesn't work if dependencies
// were installed with pnpm, so this is additional bin script
// with bun's hashbang specified explicitly
run(import.meta.url)
