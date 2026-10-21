import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { resolve } from 'node:path'

import type { NeemBuildContext } from '@nmtjs/neem'
import { afterAll, beforeAll, expect, it } from 'vitest'

import { neemViteArtifactPlugin } from '../../src/plugin.ts'

// Real Vite builds through the artifact plugin's hooks, without the Neem CLI:
// `preview.spec.ts` covers how the CLI reaches the plugin, this covers where
// app config shapes and Neem's setting meet.
type ArtifactHooks = {
  configureNeemBuild(context: NeemBuildContext): void
  writeBundle(
    this: { warn(message: string): void },
    output: { dir: string },
  ): Promise<void>
}

type Maps = 'none' | 'hidden' | 'linked'

// A regular build gets no Neem setting (Vite's default applies), a preview
// gets maps on: either way an app setting at any level Vite reads wins.
const cases: readonly {
  name: string
  config: object
  build: Maps
  preview: Maps
}[] = [
  { name: 'no setting', config: {}, build: 'none', preview: 'linked' },
  {
    name: 'top-level build',
    config: { build: { sourcemap: 'hidden' } },
    build: 'hidden',
    preview: 'hidden',
  },
  {
    name: 'client environment',
    config: { environments: { client: { build: { sourcemap: false } } } },
    build: 'none',
    preview: 'none',
  },
  {
    name: 'rolldown output',
    config: { build: { rolldownOptions: { output: { sourcemap: 'hidden' } } } },
    build: 'hidden',
    preview: 'hidden',
  },
  {
    name: 'legacy rollup output array',
    config: { build: { rollupOptions: { output: [{ sourcemap: false }] } } },
    build: 'none',
    preview: 'none',
  },
]

let tmpDir = ''

beforeAll(async () => {
  // Inside the package, so the apps resolve vite from here.
  tmpDir = await mkdtemp(resolve(import.meta.dirname, '../../.tmp-maps-'))
})

afterAll(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true })
})

it.each(cases)(
  'app maps set through $name: build $build, preview $preview',
  async ({ name, config, build: built, preview }) => {
    const root = await createApp(name, config)
    expect(await buildMaps(root, 'build', undefined)).toBe(built)
    expect(await buildMaps(root, 'preview', true)).toBe(preview)
  },
  60_000,
)

it("follows Neem's explicit setting where the app sets none", async () => {
  const root = await createApp('neem setting', {})
  expect(await buildMaps(root, 'preview', false)).toBe('none')
  expect(await buildMaps(root, 'build', 'hidden')).toBe('hidden')
}, 60_000)

async function createApp(name: string, config: object): Promise<string> {
  const root = resolve(tmpDir, name.replaceAll(' ', '-'))
  await mkdir(resolve(root, 'src'), { recursive: true })
  await writeFile(
    resolve(root, 'index.html'),
    '<div id="app"></div><script type="module" src="/src/main.ts"></script>',
  )
  await writeFile(
    resolve(root, 'src/main.ts'),
    'document.querySelector("#app")!.textContent = "maps"',
  )
  await writeFile(
    resolve(root, 'vite.config.ts'),
    `export default ${JSON.stringify(config)}`,
  )
  return root
}

async function buildMaps(
  root: string,
  command: NeemBuildContext['command'],
  sourcemap: NeemBuildContext['sourcemap'],
): Promise<Maps> {
  const { assets, script, maps, linked } = await build(root, command, sourcemap)
  if (maps.length === 0) return 'none'
  expect(maps).toEqual([`${script}.map`])
  const map = JSON.parse(await readFile(resolve(assets, maps[0]!), 'utf8')) as {
    sources: string[]
  }
  expect(map.sources).toEqual(
    expect.arrayContaining([expect.stringMatching(/src\/main\.ts$/)]),
  )
  return linked ? 'linked' : 'hidden'
}

async function build(
  root: string,
  command: NeemBuildContext['command'],
  sourcemap: NeemBuildContext['sourcemap'],
) {
  const plugin = neemViteArtifactPlugin({ root }) as unknown as ArtifactHooks
  plugin.configureNeemBuild({ command, mode: 'production', sourcemap })
  const dir = resolve(root, `out-${command}-${String(sourcemap)}`)
  await plugin.writeBundle.call({ warn: () => {} }, { dir })

  const assets = resolve(dir, 'app/assets')
  const files = await readdir(assets)
  const script = files.find((file) => file.endsWith('.js'))
  if (!script) throw new Error(`No script in ${assets}`)
  const source = await readFile(resolve(assets, script), 'utf8')
  return {
    assets,
    script,
    maps: files.filter((file) => file.endsWith('.map')),
    linked: source.includes(`//# sourceMappingURL=${script}.map`),
  }
}
