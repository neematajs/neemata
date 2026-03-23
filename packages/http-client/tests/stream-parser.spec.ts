import { Buffer } from 'node:buffer'

import { describe, expect, it } from 'vitest'

import { HttpStreamParser } from '../src/http-stream-parser.ts'

const createBase64 = (chunk: Uint8Array) =>
  Buffer.from(chunk).toString('base64')

const parseFromParts = (parts: string[]) => {
  const parser = new HttpStreamParser()
  const chunks: string[] = []

  for (const part of parts) {
    parser.push(part, (data) => {
      chunks.push(data)
    })
  }

  parser.finish((data) => {
    chunks.push(data)
  })

  return chunks.map((chunk) => Uint8Array.from(Buffer.from(chunk, 'base64')))
}

describe('HttpStreamParser', () => {
  it('parses highly fragmented frames with split separators and multiline data', () => {
    const first = new Uint8Array([10, 11, 12, 13])
    const second = new Uint8Array([21, 22])

    const firstBase64 = createBase64(first)
    const secondBase64 = createBase64(second)

    const firstLeft = firstBase64.slice(0, 3)
    const firstRight = firstBase64.slice(3)
    const secondLeft = secondBase64.slice(0, 2)
    const secondRight = secondBase64.slice(2)

    const chunks = parseFromParts([
      'da',
      'ta: ',
      firstLeft,
      '\r',
      '\n',
      'data:',
      ` ${firstRight}`,
      '\r\n',
      '\r',
      '\n',
      'event: ignored\n',
      'data',
      ': ',
      secondLeft,
      secondRight,
      '\n',
      '\n',
    ])

    expect(chunks.map((chunk) => Array.from(chunk))).toEqual([
      Array.from(first),
      Array.from(second),
    ])
  })

  it('parses LF-delimited frames split across chunks', () => {
    const first = new Uint8Array([1, 2, 3])
    const second = new Uint8Array([9, 8])

    const firstBase64 = createBase64(first)
    const secondBase64 = createBase64(second)

    const chunks = parseFromParts([
      `data: ${firstBase64.slice(0, 2)}`,
      `${firstBase64.slice(2)}\n\n`,
      `data: ${secondBase64}\n\n`,
    ])

    expect(chunks.map((chunk) => Array.from(chunk))).toEqual([
      Array.from(first),
      Array.from(second),
    ])
  })

  it('parses CRLF-delimited frames', () => {
    const first = new Uint8Array([5, 6])
    const second = new Uint8Array([7])

    const chunks = parseFromParts([
      `data: ${createBase64(first)}\r\n\r\n`,
      `data: ${createBase64(second)}\r\n\r\n`,
    ])

    expect(chunks.map((chunk) => Array.from(chunk))).toEqual([
      Array.from(first),
      Array.from(second),
    ])
  })

  it('errors on malformed trailing data', () => {
    const frame = `data: ${createBase64(new Uint8Array([1]))}\n\n`
    const parser = new HttpStreamParser()
    const parsed: string[] = []

    parser.push(`${frame}broken_tail`, (data) => {
      parsed.push(data)
    })

    expect(parsed).toEqual([createBase64(new Uint8Array([1]))])
    expect(() => {
      parser.finish(() => {})
    }).toThrow('Malformed stream response frame')
  })
})
