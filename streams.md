# Streams Architecture Review & Proposal

## Current Architecture Review

The current streaming implementation in `neemata` relies on a combination of WebSocket transport multiplexing and a custom JSON-based protocol.

### Overview

1.  **Protocol**: The protocol defines message types for RPC calls and Stream operations (`ClientStreamPush`, `ServerStreamPush`, `ClientStreamPull`, etc.).
2.  **Serialization**: The default `JsonFormat` uses `JSON.stringify` with a custom `replacer` function to detect `ProtocolBlob` objects. When a `ProtocolBlob` is encountered, it is registered in a `streams` map, and the blob in the JSON payload is replaced with a serialized Stream ID.
3.  **Multiplexing**: Streams are multiplexed over the single WebSocket connection. Chunks are sent as binary messages with a header indicating the message type and stream ID.
4.  **Backpressure**: A credit-based flow control mechanism is implemented using `ClientStreamPull` messages. The receiver requests a certain amount of data (`size`), and the sender sends chunks until that size is reached.

### Weaknesses & Fragility

1.  **JSON Serialization Hack**:
    *   The reliance on `JSON.stringify`'s `replacer` is fragile. It requires traversing the entire object graph.
    *   `JSON.stringify` is synchronous and blocking. For large payloads, this can block the event loop.
    *   It forces the payload to be JSON, which is inefficient for binary data (requiring Base64 encoding for non-stream binary data).

2.  **Complex Stream Lifecycle**:
    *   The lifecycle management (open, push, pull, abort, end) is spread across multiple files (`connection.ts`, `gateway.ts`, `protocol.ts`).
    *   The `DuplexStream` implementation in `common/src/streams.ts` is a custom implementation that mimics `TransformStream` but might have subtle bugs or deviations from standard Web Streams API.

3.  **Naming Confusion**:
    *   `ProtocolServerBlobStream` is used on the client to represent a stream *from* the server, which is confusing.
    *   `ProtocolBlob` wraps various source types, but its integration with the protocol is somewhat implicit via the `replacer`.

4.  **Deep Nesting Support**:
    *   While the current implementation *does* support deep nesting via `JSON.stringify`, it is tied to the JSON format. If a user wants to use a different format (e.g., for performance), they would need to reimplement the stream extraction logic.

## Alternative Architecture Proposal

To address the weaknesses, I propose moving to a **Binary Serialization Format** with native support for **Extension Types**.

### 1. Binary Serialization (MessagePack)

Instead of JSON, use **MessagePack** (e.g., via `msgpackr`). MessagePack is a binary serialization format that is faster and more compact than JSON.

*   **Native Binary Support**: MessagePack supports binary data natively, so no Base64 encoding is needed.
*   **Extension Types**: MessagePack allows defining custom Extension Types. We can define a specific extension type for **Streams**.

### 2. Stream Extension Type

Define a MessagePack Extension Type (e.g., type ID `0x01`) for `StreamReference`.

*   **Encoding**: When the encoder encounters a `ProtocolBlob` (or `Stream`), it encodes it as an Extension Type `0x01`. The payload of the extension is the **Stream ID** (and optionally metadata).
*   **Decoding**: When the decoder encounters Extension Type `0x01`, it reads the Stream ID and creates a `ProtocolStream` object (or looks it up).

**Benefits**:
*   **Performance**: Encoding/decoding is much faster.
*   **Robustness**: No need for `replacer` hacks. The parser handles the structure naturally.
*   **Flexibility**: Streams can be embedded anywhere (arrays, maps, deep objects) without special traversal logic.

### 3. Unified Stream Interface

*   Adopt standard **Web Streams API** (`ReadableStream`, `WritableStream`, `TransformStream`) everywhere.
*   Remove custom `DuplexStream` if possible, or ensure it strictly adheres to the standard.
*   Rename classes for clarity:
    *   `RemoteStream`: A stream representing data coming from the other side.
    *   `LocalStream`: A stream representing data being sent to the other side.

### 4. Simplified Protocol

The protocol can remain largely the same (RPC + Stream chunks), but the payload encoding becomes simpler.

**Example Flow**:

1.  **Client**:
    ```typescript
    const blob = new ProtocolBlob(myFile);
    await client.rpc.upload({ file: blob, meta: { ... } });
    ```
2.  **Encoder**:
    *   Serializes the object to MessagePack.
    *   Encounters `blob`. Assigns Stream ID `1`.
    *   Writes Extension `0x01` with payload `1`.
    *   Returns buffer.
3.  **Transport**:
    *   Sends RPC message with the buffer.
    *   Starts listening for `Pull` requests for Stream `1`.
4.  **Server**:
    *   Receives RPC message.
    *   Decodes MessagePack.
    *   Encounters Extension `0x01` with payload `1`.
    *   Creates `RemoteStream(id=1)`.
    *   Passes the decoded object (with `RemoteStream`) to the procedure.

### 5. Implementation Details

*   **Library**: Use `msgpackr` for high-performance MessagePack serialization.
*   **Context**: The `Encoder`/`Decoder` needs access to a `StreamContext` to register/lookup streams. This is already present in the current architecture (`MessageContext`) and should be preserved.

### 6. Backpressure & Flow Control

*   Keep the current credit-based flow control (`Pull` messages). It works well for multiplexing.
*   Ensure that `RemoteStream` implements `ReadableStream` correctly, so that `controller.enqueue` respects the high water mark (though with `Pull` messages, the flow is controlled by the consumer requesting data).

## Conclusion

Switching to a binary format with extension types will make the system more robust, faster, and cleaner. It eliminates the fragility of JSON manipulation and provides a solid foundation for handling complex data structures with embedded streams.
