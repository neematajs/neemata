---
applyTo: "tests/**/*"
---

# Gateway + Client Integration Testing

Comprehensive integration test suite for the Neemata protocol, testing client and gateway packages together using a real in-process EventEmitter transport.

## Philosophy

1. **True end-to-end testing** - Real client ↔ gateway communication, no mocking of protocol or format
2. **In-process transport** - Use EventEmitter channels to avoid network I/O while maintaining real async message passing
3. **Shared test setup** - All bootstrapping in `_setup.ts`, reused across test files
4. **Memory leak focus** - Every test category verifies proper resource cleanup
5. **Split test files** - Organized by feature category for maintainability
6. **Methodology** - Instead of chaotically trying to make tests pass, we carefully design each test to validate specific behaviors and cleanup. This includes logical inconsistencies. In this case explicitly point out to these bugs, and propose solutions to fix them. However, alwats prompt for explicit user consent before modifying the logic.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      Integration Test                           │
├─────────────────────────────────────────────────────────────────┤
│  StaticClient                       Gateway                     │
│  ┌──────────────────────┐          ┌──────────────────────────┐ │
│  │ Real BaseClient      │          │ Real Gateway             │ │
│  │ Real Protocol (v1)   │ ◄──────► │ Real Protocol (v1)       │ │
│  │ Real JsonFormat      │  Event   │ Real JsonFormat          │ │
│  │                      │  Emitter │ Real Procedures          │ │
│  └──────────────────────┘          └──────────────────────────┘ │
│                │                              │                  │
│                │                              │                  │
│                ▼                              ▼                  │
│       EventEmitterClient            EventEmitterServer           │
│       Transport                     Transport                    │
└─────────────────────────────────────────────────────────────────┘
```

### Components

- **EventEmitterServerTransport** - Server-side transport implementing `TransportWorker` interface
- **EventEmitterClientTransport** - Client-side transport implementing `ClientTransport<Bidirectional>`
- **TransportChannel** - Bidirectional EventEmitter channel connecting client and server
- **TestClient** - Extends `StaticClient` to expose internal state (pending calls, streams) for cleanup verification
- **createTestSetup()** - Factory function that creates connected client/gateway pair

## Test File Structure

```
tests/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                  # Re-exports test utilities
│   ├── container.ts              # createTestContainer
│   ├── format.ts                 # createTestClientFormat, createTestServerFormat
│   └── logger.ts                 # createTestLogger
└── test/
    ├── _setup.ts                 # Shared test setup (transports, TestClient, createTestSetup)
    ├── integration/
    │   ├── vitest.config.ts      # Config for integration tests
    │   └── suites/
    │       ├── simple-procedures.spec.ts # Simple RPC tests
    │       ├── streaming.spec.ts         # RPC streaming tests
    │       ├── blob-upload.spec.ts       # Blob upload tests (client → server)
    │       ├── blob-download.spec.ts     # Blob download tests (server → client)
    │       ├── connection.spec.ts        # Connection lifecycle tests
    │       └── edge-cases.spec.ts        # Edge case tests
    └── sustainability/
        ├── vitest.config.ts      # Config with --expose-gc for memory tests
        └── suites/
            └── memory-leaks.spec.ts      # Memory leak prevention tests
```

### Test Categories

Tests are organized into two main categories:

1. **Integration Tests** (`test/integration/`) - Functional correctness tests for protocol features
2. **Sustainability Tests** (`test/sustainability/`) - Memory and resource cleanup tests requiring `--expose-gc`

---

## Test Categories

### Priority Matrix

| Priority | Category | Location | Tests | Reason |
|----------|----------|----------|-------|--------|
| **P0** | Memory Leak Prevention | `sustainability/` | ~5 | Critical for production stability |
| **P0** | Resource Cleanup | `integration/` | ~15 | Prevents resource exhaustion |
| **P1** | Simple RPC | `integration/` | ~10 | Core functionality |
| **P1** | RPC Streaming | `integration/` | ~12 | Common user scenario |
| **P1** | Blob Streams (Upload) | `integration/` | ~10 | File upload scenarios |
| **P1** | Blob Streams (Download) | `integration/` | ~10 | File download scenarios |
| **P2** | Connection Lifecycle | `integration/` | ~8 | Connect/disconnect handling |
| **P2** | Timeouts | `integration/` | ~8 | Robustness |
| **P3** | Concurrent Operations | `integration/` | ~8 | Real-world usage patterns |
| **P3** | Edge Cases | `integration/` | ~10 | Defensive programming |

---

## 1. Simple RPC Calls

Core request-response functionality without streaming.

### 1.1 Basic Operations
- [x] Simple call succeeds and returns result
- [x] Simple call with null payload (no input)
- [x] Simple call with complex nested objects
- [x] Simple call with arrays (standalone)
- [x] Simple call with empty object payload
- [x] Multiple sequential calls complete correctly
- [x] Multiple concurrent calls complete independently

### 1.2 Timeouts
- [x] Call times out when server takes too long
- [x] Call completes when server responds before timeout
- [x] Timeout is cleared on successful response (no leaks)
- [x] Custom per-call timeout overrides client default

### 1.3 Abort Signal
- [x] Call aborted via signal before response
- [x] Call aborted via signal during server processing
- [x] Abort signal propagates to server handler
- [x] Server handler receives aborted signal state (pre-aborted signal)

### 1.4 Error Handling
- [x] Server error propagates to client as rejection
- [x] Server throws custom error with code
- [x] Server throws ProtocolError
- [x] Call after disconnect rejects immediately

---

## 2. RPC Streaming (AsyncIterable Response)

Server returns an async iterable that client can consume.

### 2.1 Basic Streaming
- [x] Stream response yields all values successfully
- [x] Stream response with single chunk
- [x] Stream response with many chunks (100+)
- [x] Empty stream (yields nothing, ends immediately)
- [x] Stream with delays between chunks

### 2.2 Client Consumption
- [x] Client fully consumes stream (iterate all chunks)
- [x] Client partially consumes then breaks out of loop
- [x] Client cancels stream via readable.cancel()
- [x] Client aborts stream via AbortSignal

### 2.3 Backpressure
- [x] Server waits for client pull before sending next chunk
- [x] Slow client doesn't cause server buffer overflow
- [x] Fast client receives chunks without unnecessary delays

### 2.4 Error Handling
- [x] Server error mid-iteration propagates to client
- [x] Client receives RpcStreamAbort on server error (verify message type)
- [x] Server stops iteration when client aborts

### 2.5 Resource Cleanup
- [x] Server iteration cleanup on normal completion
- [x] Server iteration cleanup on client abort
- [x] Client stream cleanup on normal completion
- [x] Client stream cleanup on cancel
- [ ] No pending promises after stream ends

---

## 3. Client Blob Streams (Upload: Client → Server)

Client sends binary data to server via ProtocolBlob.

### 3.1 Basic Upload
- [x] Single blob upload fully consumed by server
- [x] Multiple blobs in single RPC payload
- [x] Large blob upload (1MB+)
- [x] Blob with custom metadata (type, size, filename)

### 3.2 Server Consumption
- [x] Server fully consumes blob stream
- [x] Server partially consumes blob stream
- [x] Server ignores blob (doesn't consume) → auto-aborted
- [x] Server reads blob into buffer completely

### 3.3 Client Lifecycle
- [x] Client stream sends data on server pull
- [x] Client stream ends after all data sent
- [x] Client aborts stream mid-transfer (via AbortSignal)
- [x] Client handles server abort message (documented known issue: gateway doesn't send ClientStreamAbort)

### 3.4 Backpressure
- [x] Client waits for server pull before sending (implicit in pull-based protocol)
- [x] Large upload respects backpressure

### 3.5 Error Handling
- [x] Client source error propagates as abort
- [x] Server abort stops client sending (cleanup verified, known issue with client stream map)
- [x] Connection close aborts upload

### 3.6 Different Source Types
- [x] Minimal blob (single byte) - empty blobs rejected by design
- [x] Blob from ReadableStream
- [x] Blob from async iterable via ReadableStream

### 3.7 Edge Cases
- [x] Multiple racing uploads followed by disconnect
- [x] Upload immediately after connect
- [x] Sequential uploads correctly isolated
- [x] Long filename in metadata
- [x] Special characters in filename

---

## 4. Server Blob Streams (Download: Server → Client)

Server sends binary data to client via ProtocolBlob.

### 4.1 Basic Download
- [x] Single blob download fully consumed by client
- [x] Large blob download (1MB+)
- [x] Blob with metadata preserved (type, filename, size)
- [x] Binary data download (via echoBlob)

### 4.2 Client Consumption
- [x] Client fully consumes blob stream
- [x] Client partially consumes then stops (break)
- [x] Client ignores blob (doesn't consume) - verified call cleanup
- [x] Client reads blob into buffer completely
- [x] Client receives multiple chunks correctly

### 4.3 Server Lifecycle
- [x] Server stream pushes data on client pull (via slow download)
- [x] Server stream ends after all data sent
- [ ] Server handles client abort message (TODO: verify server-side cleanup)

### 4.4 Backpressure
- [x] Large download respects backpressure (with slow consumer)

### 4.5 Error Handling
- [ ] Server source error propagates as abort (TODO: error propagation may need work)
- [x] Client abort stops server sending (via signal)
- [x] Connection close aborts download

### 4.6 Resource Cleanup
- [x] Clean up server streams after download complete
- [x] Clean up after multiple concurrent downloads
- [x] Clean up after partial download

### 4.7 Edge Cases
- [x] Download immediately after connect
- [x] Sequential downloads correctly isolated
- [x] Multiple racing downloads followed by disconnect
- [x] Long filename in metadata
- [x] Special characters in filename

---

## 5. Connection Lifecycle

Connection establishment, maintenance, and teardown.

### 5.1 Connection Establishment
- [x] Client connects successfully
- [x] Connected event emitted on client
- [x] Gateway creates connection with correct protocol version
- [ ] Gateway resolves connection identity

### 5.2 Disconnection
- [x] Client disconnect triggers cleanup (happens but not verified)
- [x] Disconnected event emitted with reason
- [x] All pending calls rejected on disconnect
- [ ] All streams aborted on disconnect
- [x] Connection container disposed

### 5.3 Reconnection
- [x] Client can reconnect after disconnect
- [x] New connection has fresh state
- [x] Old connection resources don't leak

### 5.4 Connection State
- [ ] Can query connection state (connected/disconnected)
- [ ] Operations fail gracefully when disconnected

---

## 6. Memory Leak Prevention

**CRITICAL: End-to-end resource cleanup verification.**

These tests must verify that internal state maps on BOTH client and gateway are properly cleaned up after operations complete. This requires inspecting private fields or exposing test-only accessors.

### Gateway Internal State Access

The `Gateway` class exposes its internal managers as public readonly properties, allowing tests to directly verify cleanup:

```typescript
// Available for inspection in tests via setup.gateway:
setup.gateway.connections  // ConnectionManager - tracks active connections
setup.gateway.rpcs         // RpcManager - tracks pending RPCs and stream pulls
setup.gateway.blobStreams  // BlobStreamsManager - tracks blob upload/download streams

// Example assertions:
expect(setup.gateway.rpcs.rpcs.size).toBe(0)      // No pending RPCs
expect(setup.gateway.rpcs.streams.size).toBe(0)   // No pending stream pulls
expect(setup.gateway.blobStreams.clientStreams.size).toBe(0)  // No upload streams
expect(setup.gateway.blobStreams.serverStreams.size).toBe(0)  // No download streams
```

### Client Internal State Access

The `TestClient` class (defined in `_setup.ts`) extends `StaticClient` and exposes internal state for testing. The `BaseClient` class uses `protected` fields, allowing test subclasses to access them.

```typescript
// TestClient exposes these readonly properties:
setup.client.pendingCallsCount       // Number of pending RPC calls
setup.client.activeClientStreamsCount // Number of active uploads
setup.client.activeServerStreamsCount // Number of active downloads  
setup.client.activeRpcStreamsCount    // Number of active RPC streams
setup.client.isClean                  // true if all counts are 0

// Example assertions:
expect(setup.client.pendingCallsCount).toBe(0)
expect(setup.client.isClean).toBe(true)
```

### 6.1 After Simple RPC
- [x] Client `#calls` map cleared after success
- [x] Client `#calls` map cleared after error
- [x] Client `#calls` map cleared after timeout
- [x] Client `#calls` map cleared after abort
- [x] Gateway connection's pending RPCs cleared after response

### 6.2 After RPC Stream
- [x] Gateway `rpcs` map cleared after stream completion
- [x] Gateway `rpcs` map cleared after stream abort
- [x] Gateway `rpcs` map cleared after stream error
- [x] Multiple concurrent streams cleanup properly
- [x] Client `pendingCallsCount` is 0 after stream end
- [x] Client `activeRpcStreamsCount` is 0 after stream end
- [x] Client `isClean` is true after stream completion
- [x] Client state cleared after stream abort
- [x] Client state cleared after stream error
- [~] Client `#rpcStreams` map cleared on client cancel/break (BROKEN - see Known Issues)
- [ ] Server async iterator properly returned/closed

### 6.3 After Blob Stream (Upload: Client → Server)
- [x] Client `#clientStreams` map cleared after upload complete
- [x] Client `#clientStreams` map cleared after upload abort
- [x] Gateway `clientStreams` map cleared after server consumes blob
- [x] Gateway `clientStreams` map cleared after server ignores blob
- [x] No orphaned stream controllers on either side (verified via concurrent uploads test)

### 6.4 After Blob Stream (Download: Server → Client)
- [x] Client `#serverStreams` map cleared after download complete
- [x] Client `#serverStreams` map cleared after download abort
- [x] Client `#serverStreams` map cleared after client ignores blob (partial - see note in test)
- [x] Gateway `serverStreams` map cleared after send complete
- [ ] No orphaned ReadableStream controllers

### 6.5 After Disconnect
- [x] All client internal maps empty (`#calls`, `#rpcStreams`, `#clientStreams`, `#serverStreams`)
- [x] All gateway maps empty for that connection
- [x] Connection container disposed (DI cleanup)
- [x] No resource leaks after multiple connect/disconnect cycles
- [ ] No dangling setTimeout/setInterval handles
- [ ] No unresolved promises hanging

### 6.6 Stress Tests (Sustainability Suite)

Located in `test/sustainability/suites/memory-leaks.spec.ts`. These tests require `--expose-gc` to force garbage collection for accurate heap measurements.

- [ ] Memory stable after 1000 simple calls (no growth trend)
- [ ] Memory stable after 1000 stream responses
- [ ] Memory stable after 1000 blob uploads
- [ ] Memory stable after 1000 aborted operations
- [ ] Memory stable after 100 connect/disconnect cycles

**Running sustainability tests:**
```bash
# Run with GC exposed (configured in vitest.config.ts)
pnpm vitest tests/test/sustainability --run
```

---

## 7. Concurrent Operations

Multiple simultaneous operations on same connection.

### 7.1 Multiple RPCs
- [ ] 10 concurrent simple calls complete independently (only 3 tested)
- [x] 10 concurrent stream calls complete independently
- [ ] Mixed simple and stream calls don't interfere

### 7.2 Multiple Streams
- [x] Multiple concurrent blob uploads
- [x] Multiple concurrent blob downloads
- [ ] Mixed uploads and downloads
- [ ] Interleaved stream chunks don't corrupt data

### 7.3 Abort During Concurrent Ops
- [ ] Aborting one call doesn't affect others
- [ ] Aborting one stream doesn't affect others
- [ ] Disconnect aborts all concurrent operations

---

## 8. Edge Cases

Defensive programming and protocol edge cases.

### 8.1 ID Overflow
- [ ] Call ID wraps at MAX_UINT32 without conflict
- [ ] Stream ID wraps at MAX_UINT32 without conflict

### 8.2 Race Conditions
- [x] Abort racing with response (no errors)
- [ ] Disconnect racing with response (graceful)
- [ ] Stream end racing with connection close
- [ ] Double abort is idempotent

### 8.3 Malformed Data
- [ ] Server returns unexpected type (handled)
- [ ] Empty response payload (handled)

### 8.4 Timing
- [ ] Very fast consecutive calls
- [ ] Call immediately after connect
- [ ] Disconnect during connection establishment

---

## Test Setup API

### createTestSetup()

```typescript
interface TestSetup<TRouter> {
  gateway: Gateway
  client: StaticClient<...>
  channel: TransportChannel
  cleanup: () => Promise<void>
}

interface TestSetupOptions<TRouter> {
  router?: TRouter          // Custom router (default: rootRouter)
  timeout?: number          // Client timeout in ms (default: 5000)
  guards?: []               // Custom guards for ApplicationApi
  middlewares?: []          // Custom middlewares for ApplicationApi
  filters?: []              // Custom filters for ApplicationApi
}

async function createTestSetup<TRouter>(
  options?: TestSetupOptions<TRouter>
): Promise<TestSetup<TRouter>>
```

### Usage Pattern

```typescript
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { TestSetup } from './_setup.ts'
import {
  ApiError,
  createProcedure,
  createRootRouter,
  createRouter,
  createTestSetup,
  rpcAbortSignal,
  t,
} from './_setup.ts'

// Define procedures for this test file
const echoProcedure = createProcedure({
  input: t.object({ message: t.string() }),
  output: t.object({ echoed: t.string() }),
  handler: (_, input) => ({ echoed: input.message }),
})

// Build router with procedures
const router = createRootRouter(
  createRouter({
    routes: {
      echo: echoProcedure,
    },
  }),
)

describe('Feature', () => {
  let setup: TestSetup<typeof router>

  beforeEach(async () => {
    setup = await createTestSetup({ router })
  })

  afterEach(async () => {
    await setup.cleanup()
  })

  it('should echo message', async () => {
    const result = await setup.client.call.echo({ message: 'hello' })
    expect(result).toEqual({ echoed: 'hello' })
  })
})
```

---

## Running Tests

Prefer using `tests` tool, instead of running CLI directly. But here are some common commands to use (DISCOURAGED):

```bash
# Run all integration tests
pnpm vitest tests/test/integration --run

# Run all sustainability tests (with --expose-gc)
pnpm vitest tests/test/sustainability --run

# Run specific test file
pnpm vitest tests/test/integration/suites/simple-procedures.spec.ts --run

# Run with watch mode
pnpm vitest tests/test/integration/suites/streaming.spec.ts --watch

# Run specific describe block
pnpm vitest tests/test/integration/suites/simple-procedures.spec.ts -t "Basic Operations"

# Run with coverage
pnpm vitest tests/test/integration --coverage
```

### Vitest Configuration

Each test category has its own `vitest.config.ts`:

- **Integration tests** (`test/integration/vitest.config.ts`):
  - Standard Node.js environment
  - Includes `suites/**/*.spec.ts`

- **Sustainability tests** (`test/sustainability/vitest.config.ts`):
  - Node.js environment with `--expose-gc`
  - Includes `suites/**/*.spec.ts`
  - Enables `globalThis.gc()` for forced garbage collection

---

## Implementation Notes

### Why EventEmitter Transport?

1. **Real async** - Messages are truly async via `setImmediate`, unlike direct function calls
2. **No network** - Avoids flaky tests from network issues
3. **Simple** - Easy to understand and debug
4. **In-process** - Easy debugging, no port conflicts

### Why Split Test Files?

1. **Focused testing** - Each file covers one feature area
2. **Faster feedback** - Run only relevant tests during development
3. **Shared setup** - One `_setup.ts`, imported by all test files
4. **Easy navigation** - Find tests by feature category
5. **Parallel execution** - Test files can run in parallel

### What's NOT Tested Here

These belong in unit tests for respective packages:

- Protocol encoding/decoding edge cases → `packages/protocol/test/`
- Container/DI internals → `packages/core/test/`
- Format serialization → `packages/json-format/test/`
- Transport-specific behavior → `packages/ws-transport/test/`, `packages/http-transport/test/`

---

## Known Issues

### Race Condition: Client Timeout/Abort vs Server Response

**Status**: Partially mitigated, needs further investigation

When a client-side timeout or abort occurs while the server is processing a request, there's a race condition where the server may send a response after the client has already rejected the call. The client now handles this gracefully by returning early if the call is not found in `#calls` map, but the underlying timing issue remains:

1. Client sends RPC, waits for response
2. Client timeout/abort fires → `call.reject()` called, `RpcAbort` sent to server
3. Server receives abort, throws in handler, sends error response
4. Client receives response for a call that's being cleaned up

Current mitigations in `packages/client/src/core.ts`:
- `#handleRPCResponseMessage` returns early if call not found
- Similar early returns in stream handlers

**TODO**: Investigate whether `#calls.delete(callId)` should be called immediately in the abort handler (line ~290) rather than waiting for `.finally()` cleanup to prevent edge cases where the call is still in the map when the server response arrives.

### Stream Break Does Not Cancel Underlying Stream

**Status**: Bug - causes memory leaks when breaking out of for-await loop

When a client breaks out of a `for await...of` loop consuming an RPC stream, the `ProtocolServerStreamInterface` async iterator doesn't cancel the underlying readable stream. This means the `cancel` callback (which sends `RpcAbort` to the server) is never invoked.

**Location**: `packages/protocol/src/client/stream.ts` - `ProtocolServerStreamInterface[Symbol.asyncIterator]`

**Current behavior**:
```typescript
async *[Symbol.asyncIterator]() {
  const reader = this.readable.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (!done) yield value
    else break
  }
  reader.releaseLock()  // Only releases lock, doesn't cancel
}
```

**Fix needed**: Use try-finally to cancel the reader when the iterator is terminated early:
```typescript
async *[Symbol.asyncIterator]() {
  const reader = this.readable.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (!done) yield value
      else break
    }
  } finally {
    await reader.cancel()  // Cancel triggers the cancel callback
  }
}
```

**Impact**: Server continues sending stream chunks after client stops consuming, gateway `rpcs` map retains entries until connection closes.
