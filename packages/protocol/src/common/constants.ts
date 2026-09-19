export const kBlobKey: unique symbol = Symbol.for('neemata:blobKey')
export type kBlobKey = typeof kBlobKey

// Marks an HTTP body as a raw blob in both directions; client and server must agree.
export const BLOB_HEADER = 'X-Neemata-Blob'
