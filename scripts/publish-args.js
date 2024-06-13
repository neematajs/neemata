import { parseArgs } from 'node:util'

import packageJson from '../packages/neematajs/package.json' with {
  type: 'json',
}

const { positionals } = parseArgs({ allowPositionals: true })

const [commandName, ...args] = positionals

const commands = {
  version: () => {
    const [tagName] = args
    const [packageName, version] = tagName.split('@')
    const packageNames = [packageName]
    if (packageName === packageJson.name) {
      packageNames.push(...Object.keys(packageJson.dependencies))
    }
    let output = `${version}`
    for (const packageName of packageNames) {
      output += ` --workspace=${packageName}`
    }
    process.stdout.write(output)
  },
  tag: () => {
    const [tagName] = args
    const [_, version] = tagName.split('@')
    let tag = 'latest'
    const tags = {
      alpha: /alpha/,
      beta: /beta/,
      rc: /rc/,
    }
    for (const [tagName, regex] of Object.entries(tags)) {
      if (regex.test(version)) {
        tag = tagName
        break
      }
    }
    process.stdout.write(tag)
  },
}

const command = commands[commandName]

if (command) command()
else {
  console.error(`Unknown command: ${commandName}`)
  process.exit(1)
}
