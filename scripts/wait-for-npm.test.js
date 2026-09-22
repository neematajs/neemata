import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { test } from 'node:test'

import { waitForPackages } from './wait-for-npm.js'

async function registry(t, handler) {
  const server = createServer(handler)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => {
    server.closeAllConnections()
    return new Promise((resolve) => server.close(resolve))
  })
  return `http://127.0.0.1:${server.address().port}`
}

void test('waits for every exact version and tarball before allowing the wrapper release', async (t) => {
  let pendingRequests = 0
  let availableRequests = 0
  const url = await registry(t, (request, response) => {
    if (request.url === '/pending.tgz') {
      pendingRequests++
      response.statusCode = pendingRequests < 3 ? 404 : 200
    } else if (request.url === '/available.tgz') {
      availableRequests++
    } else {
      const [name, version] = request.url
        .slice(1)
        .split('/')
        .map(decodeURIComponent)
      const file = name === '@test/pending' ? 'pending.tgz' : 'available.tgz'
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({ name, version, dist: { tarball: `${url}/${file}` } }),
      )
      return
    }
    assert.equal(request.method, 'HEAD')
    response.end()
  })

  await waitForPackages(
    [
      ['@test/pending', '1.0.0-beta.8'],
      ['@test/available', '1.0.0-beta.8'],
    ],
    { registry: url, timeout: 1000, interval: 1, settle: 0 },
  )
  assert.equal(pendingRequests, 3)
  assert.equal(availableRequests, 1)
})

void test('a different published version cannot satisfy the release and eventually fails', async (t) => {
  let tarballRequests = 0
  const url = await registry(t, (request, response) => {
    if (request.url === '/binding.tgz') {
      tarballRequests++
      response.end()
      return
    }
    response.setHeader('content-type', 'application/json')
    response.end(
      JSON.stringify({
        name: '@test/binding',
        version: '1.0.0-beta.7',
        dist: { tarball: `${url}/binding.tgz` },
      }),
    )
  })

  await assert.rejects(
    waitForPackages([['@test/binding', '1.0.0-beta.8']], {
      registry: url,
      timeout: 50,
      interval: 10,
      settle: 0,
    }),
    /Timed out waiting for npm packages: @test\/binding@1.0.0-beta.8/,
  )
  assert.equal(tarballRequests, 0)
})
