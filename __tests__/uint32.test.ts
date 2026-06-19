import { describe, it, expect } from 'vitest'
import { readUint32BE, writeUint32BE } from '../src/bundle/uint32.js'

describe('uint32 BE helpers', () => {
  it('round-trips values including the high bit', () => {
    for (const v of [0, 1, 255, 256, 0x01020304, 0xffffffff]) {
      const buf = new Uint8Array(4)
      writeUint32BE(buf, 0, v)
      expect(readUint32BE(buf, 0)).toBe(v)
    }
  })
  it('writes big-endian byte order at an offset', () => {
    const buf = new Uint8Array(6)
    writeUint32BE(buf, 2, 0x01020304)
    expect([...buf]).toEqual([0, 0, 0x01, 0x02, 0x03, 0x04])
  })
})
