import {
  isMainThread,
  parentPort,
  Worker,
  workerData,
} from 'node:worker_threads'

import type app from 'neemata-test-playground-app-1'
import { StaticClient } from '@nmtjs/client/static'
import { JsonFormat } from '@nmtjs/json-format/client'
import { ProtocolVersion } from '@nmtjs/protocol'
import { WsTransportFactory } from '@nmtjs/ws-client'
import * as promClient from 'prom-client'

const WORKER_COUNT = 2
const CLIENTS_PER_WORKER = 10
const RPC_ENDPOINT = 'http://127.0.0.1:8080'
const LATENCY_BATCH_SIZE = 1000

type WorkerConfig = { workerId: number; clientsPerWorker: number }

type WorkerMessage =
  | { type: 'latencyBatch'; values: number[] }
  | { type: 'error'; workerId: number; clientId: number; message: string }

if (isMainThread) {
  const Registry = promClient.Registry
  const register = new Registry()

  const histogram = new promClient.Histogram({
    name: 'client_rpc_latency_seconds',
    buckets: [
      0.0001, 0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
    ],
    help: 'RPC call latency in seconds',
    registers: [register],
  })

  const requestCounter = new promClient.Counter({
    name: 'client_rpc_requests_total',
    help: 'Total RPC requests issued by the client load generator',
    registers: [register],
  })

  await runMainThread(register, histogram, requestCounter)
} else {
  await runWorker(workerData as WorkerConfig)
}

async function runMainThread(
  register: promClient.Registry,
  histogram: promClient.Histogram<string>,
  requestCounter: promClient.Counter<string>,
) {
  const pushMetrics = async () => {
    globalThis.gc?.()
    const metrics = await register.metrics()
    const req = await fetch('http://localhost:9091/metrics/job/client', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain; version=0.0.4' },
      body: metrics,
    })
    if (!req.ok) {
      console.error('Failed to push metrics to Pushgateway:', req.statusText)
    }
  }

  await pushMetrics()
  setInterval(() => {
    void pushMetrics().catch((error) => {
      console.error('Failed to export metrics', error)
    })
  }, 1000)

  for (let workerId = 0; workerId < WORKER_COUNT; workerId++) {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: { workerId, clientsPerWorker: CLIENTS_PER_WORKER },
      execArgv: process.execArgv,
    })

    worker.on('message', (message: WorkerMessage) => {
      if (message.type === 'latencyBatch') {
        requestCounter.inc(message.values.length)
        for (const value of message.values) {
          histogram.observe(value)
        }
      } else if (message.type === 'error') {
        console.error(
          `Worker ${message.workerId} client ${message.clientId} error: ${message.message}`,
        )
      }
    })

    worker.on('error', (error) => {
      console.error(`Worker ${workerId} crashed`, error)
    })

    worker.on('exit', (code) => {
      if (code !== 0) {
        console.error(`Worker ${workerId} exited with code ${code}`)
      }
    })
  }
}

async function runWorker({ workerId, clientsPerWorker }: WorkerConfig) {
  const latencies: number[] = Array.from({ length: LATENCY_BATCH_SIZE })
  let count = 0

  const flushLatencies = () => {
    count = 0
    parentPort?.postMessage({ type: 'latencyBatch', values: latencies })
  }

  const recordLatency = (value: number) => {
    latencies[count++] = value
    if (count > LATENCY_BATCH_SIZE) flushLatencies()
  }

  const clients = await Promise.all(
    Array.from({ length: clientsPerWorker }, async (_, clientIndex) => {
      const client = buildClient()
      await client.connect()
      return { client, clientIndex }
    }),
  )

  await Promise.all(
    clients.map(({ client, clientIndex }) =>
      clientLoop(workerId, clientIndex, client, recordLatency),
    ),
  )
}

function buildClient() {
  return new StaticClient(
    {
      format: new JsonFormat(),
      protocol: ProtocolVersion.v1,
      contract: undefined as unknown as (typeof app)['router']['contract'],
      application: 'test',
    },
    WsTransportFactory,
    { url: RPC_ENDPOINT },
  )
}

type RpcClient = ReturnType<typeof buildClient>

async function clientLoop(
  workerId: number,
  clientId: number,
  client: RpcClient,
  recordLatency: (value: number) => void,
) {
  while (true) {
    const start = process.hrtime.bigint()
    try {
      await client.call.strict({ test: new Date().toISOString() })
      const end = process.hrtime.bigint()
      recordLatency(Number(end - start) / 1_000_000_000)
    } catch (error) {
      parentPort?.postMessage({
        type: 'error',
        workerId,
        clientId,
        message: (error as Error).message,
      })
    }
  }
}
