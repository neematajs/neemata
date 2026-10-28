// Needs --expose-gc. Prints the status of a request still in flight when the
// proxy is stopped and its JS object is collected.
const http = require('node:http')
const { Proxy } = require('../../dist/index.js')

const get = (port, path) =>
  new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path, agent: false }, (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode))
      })
      .on('error', reject)
  })

async function main() {
  let release
  const upstream = http.createServer((req, res) => {
    if (req.url === '/slow') release = () => res.end('ok')
    else res.end('ok')
  })
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))

  let proxy = new Proxy({
    listen: '127.0.0.1:0',
    applications: [{ name: 'app', routing: { type: 'default' } }],
    healthCheckIntervalMs: 50,
  })
  await proxy.addUpstream('app', {
    type: 'port',
    transport: 'http',
    secure: false,
    hostname: '127.0.0.1',
    port: upstream.address().port,
  })
  await proxy.start()
  const { port } = proxy.address()
  while ((await get(port, '/')) !== 200) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }

  const pending = get(port, '/slow')
  while (!release) await new Promise((resolve) => setTimeout(resolve, 10))
  await proxy.stop()
  proxy = undefined
  for (let i = 0; i < 5; i++) {
    globalThis.gc()
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  release()

  process.stdout.write(String(await pending.catch((error) => error.code)))
  upstream.close()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
