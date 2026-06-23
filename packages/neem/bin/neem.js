#!/usr/bin/env node --enable-source-maps --expose-gc
import { mainCommand } from '@nmtjs/neem/cli'
import { runMain } from 'citty'

await runMain(mainCommand, {})
