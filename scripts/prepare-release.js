import {
  copyFileSync,
  existsSync,
  globSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { basename, join, relative } from 'node:path'
import { parseArgs } from 'node:util'

const { positionals } = parseArgs({ allowPositionals: true })
const [scope, version] = positionals
if (!['stack', 'proxy', 'prom-client'].includes(scope) || !version) {
  throw new Error(
    'Usage: node scripts/prepare-release.js <stack|proxy|prom-client> <version>',
  )
}

const root = process.cwd()
const proxy = join(root, 'packages/proxy')
let packages
if (scope === 'stack') {
  // Standalone packages keep their own versions when the Neem stack releases.
  packages = readdirSync(join(root, 'packages'))
    .filter((name) => name !== 'proxy' && name !== 'prom-client')
    .map((name) => join(root, 'packages', name))
} else {
  packages = [join(root, 'packages', scope)]
}

if (scope === 'proxy') {
  await prepareProxy()
}

for (const directory of packages) {
  const path = join(directory, 'package.json')
  if (!existsSync(path)) continue
  const pkg = JSON.parse(readFileSync(path, 'utf8'))
  if (pkg.private) continue
  pkg.version = version
  pkg.repository = {
    type: 'git',
    url: 'https://github.com/neematajs/neemata',
    directory: relative(root, directory),
  }
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`)

  // Imported packages retain their documentation, licensing and attribution.
  if (!existsSync(join(directory, 'README.md'))) {
    copyFileSync(join(root, 'README.md'), join(directory, 'README.md'))
  }
  if (
    !existsSync(join(directory, 'LICENSE')) &&
    !existsSync(join(directory, 'LICENSE.md'))
  ) {
    copyFileSync(join(root, 'LICENSE.md'), join(directory, 'LICENSE.md'))
  }
}

async function prepareProxy() {
  // Resolve the CLI owned by proxy, including when tests use a temporary workspace.
  const require = createRequire(
    new URL('../packages/proxy/package.json', import.meta.url),
  )
  const { NapiCli, readNapiConfig } = require('@napi-rs/cli')
  const path = join(proxy, 'package.json')
  const { packageJson, targets, binaryName } = await readNapiConfig(path)
  const artifacts = globSync('artifacts/**/*.node', { cwd: proxy })

  // N-API skips missing artifacts, so verify the full target set before mutation.
  for (const { platformArchABI } of targets) {
    const binary = `${binaryName}.${platformArchABI}.node`
    const matches = artifacts.filter((file) => basename(file) === binary)
    if (matches.length !== 1 || statSync(join(proxy, matches[0])).size === 0) {
      throw new Error(`Expected one non-empty proxy binding: ${binary}`)
    }
  }
  for (const file of ['index.js', 'index.d.ts']) {
    const loader = join(proxy, 'dist', file)
    if (!existsSync(loader) || statSync(loader).size === 0) {
      throw new Error(`Missing proxy loader: ${loader}`)
    }
  }

  packageJson.version = version
  delete packageJson.optionalDependencies
  writeFileSync(path, `${JSON.stringify(packageJson, null, 2)}\n`)
  // Regenerate from the target list so removed targets cannot be published again.
  rmSync(join(proxy, 'npm'), { recursive: true, force: true })
  const cli = new NapiCli()
  await cli.createNpmDirs({ cwd: proxy })
  await cli.artifacts({ cwd: proxy, outputDir: 'artifacts' })
  // Only prepare exact optional dependencies here; CI owns all external writes.
  await cli.prePublish({
    cwd: proxy,
    ghRelease: false,
    skipOptionalPublish: true,
  })
  for (const { platformArchABI } of targets) {
    copyFileSync(
      join(proxy, 'LICENSE.md'),
      join(proxy, 'npm', platformArchABI, 'LICENSE.md'),
    )
  }
}
