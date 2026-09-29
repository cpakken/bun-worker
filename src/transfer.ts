/** Returns bytes backed by an ArrayBuffer so ownership can move through postMessage. */
export function transferableBytes(bytes: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBuffer> {
  return bytes.buffer instanceof ArrayBuffer
    ? (bytes as Uint8Array<ArrayBuffer>)
    : Uint8Array.from(bytes)
}
