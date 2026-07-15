// TODO: get rid of lib DOM somehow...
/// <reference lib="dom" />

const utf8decoder = new TextDecoder()
const utf8encoder = new TextEncoder()

export type BinaryTypes = {
  Int8: number
  Int16: number
  Int32: number
  Uint8: number
  Uint16: number
  Uint32: number
  Float32: number
  Float64: number
  BigInt64: bigint
  BigUint64: bigint
}

export const encodeNumber = <T extends keyof BinaryTypes>(
  value: BinaryTypes[T],
  type: T,
  littleEndian = true,
) => {
  const bytesNeeded = globalThis[`${type}Array`].BYTES_PER_ELEMENT
  const ab = new ArrayBuffer(bytesNeeded)
  const dv = new DataView(ab)
  dv[`set${type}`](0, value as never, littleEndian)
  return ab
}

export const decodeNumber = <T extends keyof BinaryTypes>(
  buffer: ArrayBuffer | ArrayBufferView,
  type: T,
  offset = 0,
  littleEndian = true,
): BinaryTypes[T] => {
  // bound the DataView to the passed view, so out-of-range reads throw
  // instead of silently reading neighboring bytes of the backing buffer
  const view =
    buffer instanceof ArrayBuffer
      ? new DataView(buffer)
      : new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  return view[`get${type}`](offset, littleEndian) as BinaryTypes[T]
}

export const encodeText = (text: string) => utf8encoder.encode(text)

export const decodeText = (buffer: Parameters<typeof utf8decoder.decode>[0]) =>
  utf8decoder.decode(buffer)

export const concat = (...buffers: (ArrayBuffer | ArrayBufferView)[]) => {
  let totalLength = 0
  for (const buffer of buffers) totalLength += buffer.byteLength
  const view = new Uint8Array(totalLength)
  let offset = 0
  for (const buffer of buffers) {
    const chunk =
      buffer instanceof ArrayBuffer
        ? new Uint8Array(buffer)
        : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    view.set(chunk, offset)
    offset += chunk.byteLength
  }
  return view
}

export const UTF8Transform = () =>
  new TransformStream<string, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(encodeText(chunk))
    },
  })
