#!/usr/bin/env node --import tsx/esm --watch-preserve-output
import { run } from './cli.ts'

run(import.meta.url)
