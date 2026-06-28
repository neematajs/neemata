import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const benchDir = dirname(fileURLToPath(import.meta.url))
const requested = process.argv.slice(2)
const configs =
  requested.length > 0
    ? requested
    : readdirSync(benchDir)
        .filter(
          (file) => file.startsWith('tsconfig.') && file.endsWith('.json'),
        )
        .sort()

function metric(output, label) {
  return output.match(new RegExp(`${label}:\\s+([^\\n]+)`))?.[1]?.trim() ?? ''
}

console.log('case,status,check,total,types,instantiations,memory,firstError')

for (const config of configs) {
  const configPath = join(benchDir, config)
  let output = ''
  let status = 'ok'

  try {
    output = execFileSync(
      'pnpm',
      [
        'exec',
        'tsc',
        '-p',
        configPath,
        '--noEmit',
        '--pretty',
        'false',
        '--diagnostics',
        '--extendedDiagnostics',
        '--incremental',
        'false',
      ],
      { cwd: join(benchDir, '../../..'), encoding: 'utf8', stdio: 'pipe' },
    )
  } catch (error) {
    status = 'error'
    output = `${error.stdout ?? ''}${error.stderr ?? ''}`
  }

  const firstError =
    output
      .split('\n')
      .find((line) => line.includes('error TS'))
      ?.replaceAll(',', ';') ?? ''

  console.log(
    [
      config.replace(/^tsconfig\./, '').replace(/\.json$/, ''),
      status,
      metric(output, 'Check time'),
      metric(output, 'Total time'),
      metric(output, 'Types'),
      metric(output, 'Instantiations'),
      metric(output, 'Memory used'),
      firstError,
    ].join(','),
  )
}
