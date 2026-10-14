import type { AddressInfo, Socket } from 'node:net'
import { createConnection, createServer } from 'node:net'

/**
 * What crossed a counting proxy. The two engines use different drivers
 * (`pg` and `ioredis` against `@effect/sql-pg` and `redis`), so nothing in
 * the process counts both the same way: the wire does.
 */
export type Counts = {
  /**
   * PostgreSQL: `ReadyForQuery` answers, one per `Sync` or simple query.
   * Redis: commands sent; a driver may pipeline several into one write.
   */
  roundTrips: number
  /** PostgreSQL: statements executed, `BEGIN` and `COMMIT` included. */
  statements: number
  /** PostgreSQL: transaction blocks ended, committed or rolled back. */
  transactions: number
  /** PostgreSQL: statements that ran outside a block, each its own commit. */
  autocommits: number
  /** PostgreSQL: rows the server sent. */
  rows: number
  /** Redis: writes of the clients, which is closer to network round trips. */
  writes: number
  bytesToServer: number
  bytesFromServer: number
  /** Statements by their text, or commands by name (scripts by their hash). */
  byText: Record<string, number>
  /** PostgreSQL: rows the server sent, by the text of what they answer. */
  rowsByText: Record<string, number>
  /** PostgreSQL: bytes of those rows, by the same. */
  bytesByText: Record<string, number>
}

export type CountingProxy = {
  readonly port: number
  /** What crossed since the last `take`. */
  readonly take: () => Counts
  readonly close: () => Promise<void>
}

function empty(): Counts {
  return {
    roundTrips: 0,
    statements: 0,
    transactions: 0,
    autocommits: 0,
    rows: 0,
    writes: 0,
    bytesToServer: 0,
    bytesFromServer: 0,
    byText: {},
    rowsByText: {},
    bytesByText: {},
  }
}

type Observer = {
  /** Sees every chunk a client sends, before it is forwarded. */
  toServer(chunk: Buffer): void
  fromServer(chunk: Buffer): void
}

export async function countingProxy(
  protocol: 'postgres' | 'redis',
  target: { readonly host: string; readonly port: number },
): Promise<CountingProxy> {
  let counts = empty()
  const live = () => counts
  const sockets = new Set<Socket>()

  const server = createServer((client) => {
    const upstream = createConnection(target)
    const observer =
      protocol === 'postgres' ? observePostgres(live) : observeRedis(live)
    for (const socket of [client, upstream]) {
      socket.setNoDelay(true)
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
      // The other side is told by the close that follows.
      socket.on('error', () => {})
    }
    client.on('data', (chunk) => {
      counts.bytesToServer += chunk.length
      counts.writes += 1
      observer.toServer(chunk)
    })
    upstream.on('data', (chunk) => {
      counts.bytesFromServer += chunk.length
      observer.fromServer(chunk)
    })
    client.pipe(upstream)
    upstream.pipe(client)
    client.on('close', () => upstream.destroy())
    upstream.on('close', () => client.destroy())
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })

  return {
    port: (server.address() as AddressInfo).port,
    take: () => {
      const taken = counts
      counts = empty()
      return taken
    },
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy()
        server.close(() => resolve())
      }),
  }
}

/**
 * Splits a stream into `type, length, payload` messages. Only the payloads
 * `wanted` asks for are assembled; the others, rows above all, are skipped.
 */
function framed(
  wanted: (type: number) => boolean,
  onMessage: (type: number, payload: Buffer) => void,
  /** Sees the messages that are not `wanted`, by their type and size. */
  onSkipped: (type: number, length: number) => void = () => {},
) {
  let pending: Buffer = Buffer.alloc(0)
  let skip = 0
  /** Untyped messages still expected: startup, and before it SSL requests. */
  let untyped = 0
  /** Single bytes still expected: the answer to an SSL request. */
  let bare = 0

  return {
    expectUntyped() {
      untyped += 1
    },
    expectBare() {
      bare += 1
    },
    push(chunk: Buffer) {
      let data = pending.length > 0 ? Buffer.concat([pending, chunk]) : chunk
      for (;;) {
        if (skip > 0) {
          const skipped = Math.min(skip, data.length)
          skip -= skipped
          data = data.subarray(skipped)
          if (skip > 0) break
        }
        if (bare > 0 && data.length > 0) {
          bare -= 1
          data = data.subarray(1)
          continue
        }
        const head = untyped > 0 ? 4 : 5
        if (data.length < head) break
        const type = untyped > 0 ? 0 : data[0]!
        const length = data.readUInt32BE(head - 4) - 4
        if (untyped > 0 || wanted(type)) {
          if (data.length < head + length) break
          if (untyped > 0) untyped -= 1
          onMessage(type, data.subarray(head, head + length))
          data = data.subarray(head + length)
        } else {
          onSkipped(type, head + length)
          skip = length
          data = data.subarray(head)
        }
      }
      // A copy: the chunk it is a view of is the socket's to reuse.
      pending = data.length > 0 ? Buffer.from(data) : Buffer.alloc(0)
    },
  }
}

const SSL_REQUEST = 80877103
const GSS_REQUEST = 80877104

function cstring(payload: Buffer, from: number): [string, number] {
  const end = payload.indexOf(0, from)
  return [payload.toString('utf8', from, end), end + 1]
}

function label(text: string) {
  return text.replaceAll(/\s+/g, ' ').trim().slice(0, 120)
}

const SYNC = Symbol('sync')

function observePostgres(counts: () => Counts): Observer {
  const prepared = new Map<string, string>()
  const portals = new Map<string, string>()
  /**
   * What the server has yet to answer, in order: statements, and where a
   * `Sync` or a simple query ends a batch. A server answers in order, so the
   * rows it sends belong to the first statement here.
   */
  const waiting: (string | typeof SYNC)[] = []
  const executed = (text: string) => {
    const live = counts()
    live.statements += 1
    const key = label(text)
    live.byText[key] = (live.byText[key] ?? 0) + 1
    waiting.push(key)
  }

  /** The transaction status of the last `ReadyForQuery`; none before login. */
  let status: string | undefined
  const backend = framed(
    (type) => type === 0x5a /* Z */,
    (_type, payload) => {
      const live = counts()
      // The batch it ends is answered, whatever was left of it.
      const sync = waiting.indexOf(SYNC)
      waiting.splice(0, sync + 1)
      const next = String.fromCharCode(payload[0]!)
      // The first one answers the login, not a statement.
      if (status !== undefined) {
        live.roundTrips += 1
        if (next === 'I') {
          if (status === 'I') live.autocommits += 1
          else live.transactions += 1
        }
      }
      status = next
    },
    (type, length) => {
      const head = waiting[0]
      switch (type) {
        case 0x44 /* DataRow */: {
          const live = counts()
          live.rows += 1
          if (typeof head === 'string') {
            live.rowsByText[head] = (live.rowsByText[head] ?? 0) + 1
            live.bytesByText[head] = (live.bytesByText[head] ?? 0) + length
          }
          return
        }
        case 0x43 /* CommandComplete */:
        case 0x49 /* EmptyQueryResponse */:
          if (typeof head === 'string') waiting.shift()
          return
        case 0x45 /* ErrorResponse */: {
          // The server skips the rest of the batch.
          const sync = waiting.indexOf(SYNC)
          waiting.splice(0, sync === -1 ? waiting.length : sync)
          return
        }
      }
    },
  )

  const frontend = framed(
    (type) =>
      type === 0x51 /* Q */ ||
      type === 0x50 /* P */ ||
      type === 0x42 /* B */ ||
      type === 0x45 /* E */,
    (type, payload) => {
      switch (type) {
        case 0: {
          const code = payload.readUInt32BE(0)
          if (code === SSL_REQUEST || code === GSS_REQUEST) {
            frontend.expectUntyped()
            backend.expectBare()
          }
          return
        }
        case 0x51:
          executed(cstring(payload, 0)[0])
          waiting.push(SYNC)
          return
        case 0x50: {
          const [name, next] = cstring(payload, 0)
          prepared.set(name, cstring(payload, next)[0])
          return
        }
        case 0x42: {
          const [portal, next] = cstring(payload, 0)
          portals.set(portal, cstring(payload, next)[0])
          return
        }
        case 0x45: {
          const statement = portals.get(cstring(payload, 0)[0]) ?? ''
          return executed(prepared.get(statement) ?? `<${statement}>`)
        }
      }
    },
    (type) => {
      if (type === 0x53 /* Sync */) waiting.push(SYNC)
    },
  )
  frontend.expectUntyped()

  return {
    toServer: (chunk) => frontend.push(chunk),
    fromServer: (chunk) => backend.push(chunk),
  }
}

/** Counts RESP commands of a client by name, without assembling payloads. */
function observeRedis(counts: () => Counts): Observer {
  let line = ''
  /** Bytes of a bulk string still to come, its `\r\n` included. */
  let bulk = 0
  /** The bulk string being read, while it is one that names the command. */
  let captured: string | undefined
  let remaining = 0
  let index = 0
  let name = ''

  const ended = () => {
    const live = counts()
    live.roundTrips += 1
    live.byText[name] = (live.byText[name] ?? 0) + 1
    name = ''
  }
  const argument = (value: string | undefined) => {
    if (index === 0) name = (value ?? '').toUpperCase()
    // A script is known by its hash, a script command by what it does.
    else if (index === 1 && (name === 'EVALSHA' || name === 'SCRIPT')) {
      name += ` ${(value ?? '').slice(0, 8)}`
    }
    index += 1
    remaining -= 1
    if (remaining === 0) ended()
  }

  return {
    fromServer() {},
    toServer(chunk) {
      let at = 0
      while (at < chunk.length) {
        if (bulk > 0) {
          const taken = Math.min(bulk, chunk.length - at)
          if (captured !== undefined) {
            captured += chunk.toString('latin1', at, at + taken)
          }
          bulk -= taken
          at += taken
          if (bulk === 0) {
            argument(captured?.slice(0, -2))
            captured = undefined
          }
          continue
        }
        const end = chunk.indexOf(0x0a, at)
        if (end === -1) {
          line += chunk.toString('latin1', at)
          break
        }
        const text = (line + chunk.toString('latin1', at, end)).trimEnd()
        line = ''
        at = end + 1
        if (text.startsWith('*')) {
          remaining = Number(text.slice(1))
          index = 0
          name = ''
        } else if (text.startsWith('$')) {
          bulk = Number(text.slice(1)) + 2
          captured = index < 2 ? '' : undefined
        } else if (text.length > 0) {
          // An inline command, which no driver here sends.
          name = text.split(' ')[0]!.toUpperCase()
          ended()
        }
      }
    },
  }
}
