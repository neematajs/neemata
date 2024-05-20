import { join, relative } from 'node:path'
import { Glob } from 'bun'

const dir = process.argv.at(-1)
const root = process.argv.at(-2)

if (!dir || !root) {
  console.error('No directory or root provided')
  process.exit(1)
}

const files: string[] = []
const glob = new Glob('**/*.ts')
for await (const file of glob.scan({ cwd: join(root, dir), absolute: true })) {
  files.push(relative(root, file))
}

process.stdout.write(files.join(' '))
