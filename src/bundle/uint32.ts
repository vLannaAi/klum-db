// src/bundle/uint32.ts
/**
 * Big-endian uint32 codec for the NDBM outer container's length fields.
 * The multi-bundle framing is klum's own format; these are local so noy-db
 * need not expose low-level byte utilities.
 * @module
 */

/** Read a big-endian uint32 from `bytes` at `offset`. */
export function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) |
      (bytes[offset + 1]! << 16) |
      (bytes[offset + 2]! << 8) |
      bytes[offset + 3]!) >>> 0
  )
}

/** Write `value` as a big-endian uint32 into `bytes` at `offset`. */
export function writeUint32BE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff
  bytes[offset + 1] = (value >>> 16) & 0xff
  bytes[offset + 2] = (value >>> 8) & 0xff
  bytes[offset + 3] = value & 0xff
}
