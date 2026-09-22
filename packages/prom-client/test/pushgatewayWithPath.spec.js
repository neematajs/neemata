import http from 'node:http'
import { PassThrough } from 'node:stream'

import { describe, it, beforeEach, afterEach, vi } from 'vitest'

const assert = require('node:assert')

const pushGatewayPath = '/path'
const pushGatewayURL = 'http://192.168.99.100:9091'
const pushGatewayFullURL = pushGatewayURL + pushGatewayPath

const Registry = require('../index').Registry

describe.each([
  ['Prometheus', Registry.PROMETHEUS_CONTENT_TYPE],
  ['OpenMetrics', Registry.OPENMETRICS_CONTENT_TYPE],
])('pushgateway with path and %s registry', (tag, regType) => {
  const Pushgateway = require('../index').Pushgateway
  const register = require('../index').register
  let instance
  let request
  let registry = undefined

  beforeEach(() => {
    register.setContentType(regType)
    request = vi
      .spyOn(http, 'request')
      .mockImplementation((_options, onResponse) => {
        const response = new PassThrough()
        response.statusCode = 200
        return {
          on() {},
          write() {},
          end() {
            onResponse(response)
            response.end()
          },
        }
      })
  })

  function tests() {
    describe('pushAdd', () => {
      it('should push metrics', async () => {
        await instance.pushAdd({ jobName: 'testJob' })

        assert.strictEqual(request.mock.calls.length, 1)
        const invocation = request.mock.calls[0][0]
        assert.strictEqual(invocation.method, 'POST')
        assert.strictEqual(invocation.path, '/path/metrics/job/testJob')
      })

      it('should use groupings', async () => {
        await instance.pushAdd({
          jobName: 'testJob',
          groupings: { key: 'value' },
        })

        assert.strictEqual(request.mock.calls.length, 1)
        const invocation = request.mock.calls[0][0]
        assert.strictEqual(invocation.method, 'POST')
        assert.strictEqual(
          invocation.path,
          '/path/metrics/job/testJob/key/value',
        )
      })

      it('should escape groupings', async () => {
        await instance.pushAdd({
          jobName: 'testJob',
          groupings: { key: 'va&lue' },
        })

        assert.strictEqual(request.mock.calls.length, 1)
        const invocation = request.mock.calls[0][0]
        assert.strictEqual(invocation.method, 'POST')
        assert.strictEqual(
          invocation.path,
          '/path/metrics/job/testJob/key/va%26lue',
        )
      })
    })

    describe('push', () => {
      it('should push with PUT', async () => {
        await instance.push({ jobName: 'testJob' })

        assert.strictEqual(request.mock.calls.length, 1)
        const invocation = request.mock.calls[0][0]
        assert.strictEqual(invocation.method, 'PUT')
        assert.strictEqual(invocation.path, '/path/metrics/job/testJob')
      })

      it('should uri encode url', async () => {
        await instance.push({ jobName: 'test&Job' })

        assert.strictEqual(request.mock.calls.length, 1)
        const invocation = request.mock.calls[0][0]
        assert.strictEqual(invocation.method, 'PUT')
        assert.strictEqual(invocation.path, '/path/metrics/job/test%26Job')
      })
    })

    describe('delete', () => {
      it('should push delete with no body', async () => {
        await instance.delete({ jobName: 'testJob' })

        assert.strictEqual(request.mock.calls.length, 1)
        const invocation = request.mock.calls[0][0]
        assert.strictEqual(invocation.method, 'DELETE')
        assert.strictEqual(invocation.path, '/path/metrics/job/testJob')
      })
    })

    describe('when using basic authentication', () => {
      const USERNAME = 'unittest'
      const PASSWORD = 'unittest'
      const auth = `${USERNAME}:${PASSWORD}`

      beforeEach(() => {
        instance = new Pushgateway(
          `http://${auth}@192.168.99.100:9091${pushGatewayPath}`,
          null,
          registry,
        )
      })

      it('pushAdd should send POST request with basic auth data', async () => {
        await instance.pushAdd({ jobName: 'testJob' })

        assert.strictEqual(request.mock.calls.length, 1)
        const invocation = request.mock.calls[0][0]
        assert.strictEqual(invocation.method, 'POST')
        assert.strictEqual(invocation.auth, auth)
      })

      it('push should send PUT request with basic auth data', async () => {
        await instance.push({ jobName: 'testJob' })

        assert.strictEqual(request.mock.calls.length, 1)
        const invocation = request.mock.calls[0][0]
        assert.strictEqual(invocation.method, 'PUT')
        assert.strictEqual(invocation.auth, auth)
      })

      it('delete should send DELETE request with basic auth data', async () => {
        await instance.delete({ jobName: 'testJob' })

        assert.strictEqual(request.mock.calls.length, 1)
        const invocation = request.mock.calls[0][0]
        assert.strictEqual(invocation.method, 'DELETE')
        assert.strictEqual(invocation.auth, auth)
      })
    })

    it('should be possible to extend http/s requests with options', async () => {
      instance = new Pushgateway(
        pushGatewayFullURL,
        {
          headers: {
            'unit-test': '1',
          },
        },
        registry,
      )

      await instance.push({ jobName: 'testJob' })

      assert.strictEqual(request.mock.calls.length, 1)
      const invocation = request.mock.calls[0][0]
      assert.deepStrictEqual(invocation.headers, { 'unit-test': '1' })
    })
  }
  describe('global registry', () => {
    afterEach(() => {
      register.clear()
    })
    beforeEach(() => {
      registry = undefined
      instance = new Pushgateway(pushGatewayFullURL)
      const promClient = require('../index')
      const cnt = new promClient.Counter({ name: 'test', help: 'test' })
      cnt.inc(100)
    })
    tests()
  })
  describe('registry instance', () => {
    beforeEach(() => {
      registry = new Registry(regType)
      instance = new Pushgateway(pushGatewayFullURL, null, registry)
      const promClient = require('../index')
      const cnt = new promClient.Counter({
        name: 'test',
        help: 'test',
        registers: [registry],
      })
      cnt.inc(100)
    })
    tests()
  })
})
