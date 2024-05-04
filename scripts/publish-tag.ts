const version = process.argv.at(-1)

if (!version) {
  console.error('No tag provided')
  process.exit(1)
}

let tag = 'latest'
const reg = /v(\d+\.\d+\.\d+)-(?<label>beta|alpha)?/g
const match = reg.exec(version)
const label = match?.groups?.label
if (label) tag = label
console.log(tag)
