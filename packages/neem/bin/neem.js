#!/usr/bin/env node --enable-source-maps
import { mainCommand } from '@nmtjs/neem/cli'
import { runMain } from 'citty'

await runMain(mainCommand, {})
