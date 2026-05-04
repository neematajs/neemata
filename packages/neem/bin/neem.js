#!/usr/bin/env node
import { main } from '@nmtjs/neem/cli'

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
