import { SharedArray } from 'k6/data'
import { WebSocket } from 'k6/experimental/websockets'

const CALLS = 1

const _data = new SharedArray('data', () => {
  const tiny = JSON.parse(open('./test/stubs/tiny.json'))
  const small = JSON.parse(open('./test/stubs/small.json'))
  const medium = JSON.parse(open('./test/stubs/medium.json'))
  const big = JSON.parse(open('./test/stubs/big.json'))
  return [tiny, small, medium, big]
})

const data = {
  tiny: _data[0],
  small: _data[1],
  medium: _data[2],
  big: _data[3],
}

export default function () {
  for (let i = 0; i < 10; i++) {
    const format = new StandardJsonFormat()

    let _callId = 0
    const _calls = new Map()
    const getBody = (callId) =>
      concat(
        encodeNumber(10, 'Uint8'),
        format.encodeRPC({ callId, procedure: 'test', payload: data.tiny })
          .buffer,
      )

    // create a new websocket connection
    const ws = new WebSocket(
      `ws://127.0.0.1:8080/test?content-type=${format.contentType}&accept=${format.contentType}`,
    )
    ws.binaryType = 'arraybuffer'

    ws.addEventListener('open', async () => {
      for (let i = 0; i < CALLS; i++) {
        const callId = _callId++
        const body = getBody(callId)
        let resolve
        const promise = new Promise((res) => {
          resolve = res
        })
        _calls.set(callId, resolve)
        ws.send(body)
        await promise
      }
      ws.close()
    })

    ws.addEventListener('message', (event) => {
      const rpc = format.decodeRPC(
        new Uint8Array(event.data).slice(Uint8Array.BYTES_PER_ELEMENT),
      )
      const resolve = _calls.get(rpc.callId)
      if (resolve) {
        resolve(rpc.result)
        _calls.delete(rpc.callId)
      }
    })
  }
}

/**
 * Standard JSON encoding format with no Neemata streams support.
 */
class StandardJsonFormat {
  contentType = 'application/json'
  encode(data) {
    return utf8Encode(JSON.stringify(data))
  }
  encodeRPC(rpc) {
    const { callId, procedure, payload } = rpc
    const streams = {}
    const buffer = this.encode([callId, procedure, payload])
    return { buffer, streams }
  }
  decode(data) {
    return JSON.parse(utf8Decode(data))
  }
  decodeRPC(buffer) {
    const streams = {}
    const [callId, error, result] = this.decode(buffer)
    if (error) return { callId, error }
    else return { callId, result, streams }
  }
}

// const utf8decoder = new TextDecoder()
// const utf8encoder = new TextEncoder()
const encodeNumber = (value, type, littleEndian = false) => {
  const bytesNeeded = globalThis[`${type}Array`].BYTES_PER_ELEMENT
  const ab = new ArrayBuffer(bytesNeeded)
  const dv = new DataView(ab)
  dv[`set${type}`](0, value, littleEndian)
  return new Uint8Array(ab)
}
const decodeNumber = (buffer, type, offset = 0, littleEndian = false) => {
  const view = new DataView(buffer)
  return view[`get${type}`](offset, littleEndian)
}
// const encodeText = (text) => utf8encoder.encode(text).buffer
// const decodeText = (buffer) => utf8decoder.decode(buffer)
const concat = (...buffers) => {
  const totalLength = buffers.reduce(
    (acc, buffer) => acc + buffer.byteLength,
    0,
  )
  const view = new Uint8Array(totalLength)
  let offset = 0
  for (const buffer of buffers) {
    view.set(buffer, offset)
    offset += buffer.byteLength
  }
  return view.buffer
}

// function utf8Decode(bytes) {
//   let result = ''
//   let i = 0
//   while (i < bytes.length) {
//     let charCode
//     if ((bytes[i] & 0x80) === 0) {
//       // 1-byte sequence (0xxxxxxx)
//       charCode = bytes[i]
//       i += 1
//     } else if ((bytes[i] & 0xe0) === 0xc0) {
//       // 2-byte sequence (110xxxxx 10xxxxxx)
//       charCode = ((bytes[i] & 0x1f) << 6) | (bytes[i + 1] & 0x3f)
//       i += 2
//     } else if ((bytes[i] & 0xf0) === 0xe0) {
//       // 3-byte sequence (1110xxxx 10xxxxxx 10xxxxxx)
//       charCode =
//         ((bytes[i] & 0x0f) << 12) |
//         ((bytes[i + 1] & 0x3f) << 6) |
//         (bytes[i + 2] & 0x3f)
//       i += 3
//     } else if ((bytes[i] & 0xf8) === 0xf0) {
//       // 4-byte sequence (11110xxx 10xxxxxx 10xxxxxx 10xxxxxx)
//       charCode =
//         ((bytes[i] & 0x07) << 18) |
//         ((bytes[i + 1] & 0x3f) << 12) |
//         ((bytes[i + 2] & 0x3f) << 6) |
//         (bytes[i + 3] & 0x3f)
//       i += 4
//     } else {
//       // Handle invalid UTF-8 or other cases as needed
//       i += 1 // Skip invalid byte
//       continue
//     }
//     result += String.fromCodePoint(charCode)
//   }
//   return result
// }

// function utf8Encode(str) {
//   return new Uint8Array(
//     unescape(encodeURIComponent(str))
//       .split('')
//       .map((char) => '%' + ('00' + char.charCodeAt(0).toString(16)).slice(-2))
//       .join('')
//       .split('%')
//       .slice(1)
//       .map((hex) => Number.parseInt(hex, 16)),
//   )
// }

function utf8Encode(str) {
  // Use encodeURIComponent to escape all special characters, treating the input as UTF-8
  const utf8String = encodeURIComponent(str)
  // Convert the escaped string to a byte array
  const bytes = []
  for (let i = 0; i < utf8String.length; i++) {
    const char = utf8String[i]

    if (char === '%') {
      // Decode hex escape sequence into a single byte value
      bytes.push(Number.parseInt(utf8String.substring(i + 1, i + 3), 16))
      i += 2
    } else {
      // Unescaped characters are single-byte ASCII
      bytes.push(char.charCodeAt(0))
    }
  }
  return new Uint8Array(bytes)
}

function utf8Decode(bytes) {
  // Convert Uint8Array to a string of single-byte code points
  let codePoints = ''
  for (let i = 0; i < bytes.length; i++) {
    // String.fromCodePoint treats each byte as a distinct code point
    codePoints += String.fromCodePoint(bytes[i])
  }
  // Use decodeURIComponent to reverse the encoding and handle multi-byte characters
  return decodeURIComponent(codePoints)
}
