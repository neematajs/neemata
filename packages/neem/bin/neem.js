#!/usr/bin/env node --enable-source-maps
import { devCommand, mainCommand } from '@nmtjs/neem/cli'
import { runCommand, runMain } from 'citty'

if (process.env.NEEM_DEV_PROCESS) {
  await runCommand(devCommand, { rawArgs: process.argv.slice(2), data: true })
} else {
  await runMain(mainCommand, {})
}
