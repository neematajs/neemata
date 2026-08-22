export class HttpStreamParser {
  private pending = ''

  push(chunk: string, emit: (data: string) => void) {
    this.pending += chunk
    this.pending = this.parse(this.pending, emit)
  }

  finish(emit: (data: string) => void) {
    this.pending = this.parse(this.pending, emit)

    if (this.pending.trim().length > 0) {
      throw new Error('Malformed stream response frame')
    }
  }

  private parse(pending: string, emit: (data: string) => void): string {
    let cursor = 0

    while (true) {
      const separator = this.findNextEventSeparator(pending, cursor)
      if (!separator) break

      this.emitEventDataFrame(pending, cursor, separator.index, emit)
      cursor = separator.index + separator.length
    }

    if (cursor === 0) return pending
    return pending.slice(cursor)
  }

  private findNextEventSeparator(
    source: string,
    fromIndex: number,
  ): { index: number; length: number } | null {
    const lf = source.indexOf('\n\n', fromIndex)
    const crlf = source.indexOf('\r\n\r\n', fromIndex)

    if (lf < 0 && crlf < 0) return null
    if (lf < 0) return { index: crlf, length: 4 }
    if (crlf < 0) return { index: lf, length: 2 }
    return lf < crlf ? { index: lf, length: 2 } : { index: crlf, length: 4 }
  }

  private emitEventDataFrame(
    source: string,
    start: number,
    end: number,
    emit: (data: string) => void,
  ) {
    const chunks: string[] = []
    let lineStart = start

    while (lineStart <= end) {
      let lineEnd = source.indexOf('\n', lineStart)
      if (lineEnd < 0 || lineEnd > end) lineEnd = end

      let contentEnd = lineEnd
      if (
        contentEnd > lineStart &&
        source.charCodeAt(contentEnd - 1) === 13 /* \r */
      ) {
        contentEnd -= 1
      }

      if (
        contentEnd - lineStart >= 5 &&
        source.charCodeAt(lineStart) === 100 /* d */ &&
        source.charCodeAt(lineStart + 1) === 97 /* a */ &&
        source.charCodeAt(lineStart + 2) === 116 /* t */ &&
        source.charCodeAt(lineStart + 3) === 97 /* a */ &&
        source.charCodeAt(lineStart + 4) === 58 /* : */
      ) {
        let dataStart = lineStart + 5
        while (dataStart < contentEnd) {
          const code = source.charCodeAt(dataStart)
          if (code !== 32 /* space */ && code !== 9 /* tab */) break
          dataStart += 1
        }
        chunks.push(source.slice(dataStart, contentEnd))
      }

      if (lineEnd >= end) break
      lineStart = lineEnd + 1
    }

    if (!chunks.length) return
    const data = chunks.join('\n')
    if (data.length > 0) emit(data)
  }
}
