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
// `preview.spec.ts` covers how the CLI reaches the plugin, this covers app
// config shapes that set maps somewhere other than `build.sourcemap`.
type ArtifactHooks = {
  configureNeemBuild(context: NeemBuildContext): void
  writeBundle(
    this: { warn(message: string): void },
    output: { dir: string },
  ): Promise<void>
}

// Each config enables maps at the top level and opts out at a level Vite
// reads with higher precedence, so a regular build proves the opt-out is
// honoured and a preview proves it is overridden.
const cases = [
  {
    name: 'client environment',
    config: {
      build: { sourcemap: true },
      environments: { client: { build: { sourcemap: false } } },
    },
    regular: 'none',
  },
  {
    name: 'client environment output',
    config: {
      environments: {
        client: {
          build: {
            sourcemap: true,
            rolldownOptions: { output: { sourcemap: false } },
          },
        },
      },
    },
    regular: 'none',
  },
  {
    name: 'rolldown output array',
    config: {
      build: {
        sourcemap: true,
        rolldownOptions: { output: [{ sourcemap: false }] },
      },
    },
    regular: 'none',
  },
  {
    name: 'legacy rollup output',
    config: {
      build: {
        sourcemap: true,
        rollupOptions: { output: { sourcemap: 'hidden' } },
      },
    },
    regular: 'hidden',
  },
] as const

let tmpDir = ''

beforeAll(async () => {
  // Inside the package, so the apps resolve vite from here.
  tmpDir = await mkdtemp(resolve(import.meta.dirname, '../../.tmp-maps-'))
})

afterAll(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true })
})

it.each(cases)(
  'regular build keeps and preview overrides maps set through $name',
  async ({ name, config, regular }) => {
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

    const built = await build(root, 'build')
    expect(built.linked).toBe(false)
    expect(built.maps).toEqual(
      regular === 'hidden' ? [`${built.script}.map`] : [],
    )

    const previewed = await build(root, 'preview')
    expect(previewed.linked).toBe(true)
    expect(previewed.maps).toEqual([`${previewed.script}.map`])
    const map = JSON.parse(
      await readFile(resolve(previewed.assets, previewed.maps[0]!), 'utf8'),
    ) as { sources: string[] }
    expect(map.sources).toEqual(
      expect.arrayContaining([expect.stringMatching(/src\/main\.ts$/)]),
    )
  },
  60_000,
)

async function build(root: string, command: NeemBuildContext['command']) {
  const plugin = neemViteArtifactPlugin({ root }) as unknown as ArtifactHooks
  plugin.configureNeemBuild({ command, mode: 'production' })
  const dir = resolve(root, `out-${command}`)
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
