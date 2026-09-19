#!/usr/bin/env node

import { parseArgs } from 'node:util'

const { positionals } = parseArgs({ allowPositionals: true })
const [version] = positionals
if (!version) throw new Error('Expected a version to derive a dist-tag from')

process.stdout.write(/alpha|beta|rc/.exec(version)?.[0] ?? 'latest')
