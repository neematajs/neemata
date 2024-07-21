#!/usr/bin/env node --import tsx/esm --watch-preserve-output
import { run } from '@neematajs/cli'

run(import.meta.url)
