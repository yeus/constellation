import { peerIdFromMultihash, peerIdFromString } from '@libp2p/peer-id'
import { multiaddr } from '@multiformats/multiaddr'
import { unzlibSync, zlibSync } from 'fflate'
import { decode as decodeMultihash } from 'multiformats/hashes/digest'

import { base64UrlToBytes, bytesToBase64Url } from './encoding.ts'
import type { ShareCapability } from './shareLink.ts'

const MAX_PACKED_BYTES = 4_096

// Envelope version 2 is independent of the capability's security version (v=1).
// Each variable field has a codec tag and a big-endian uint16 byte length.
const decodeField = (tag: number, bytes: Uint8Array): string => {
  switch (tag) {
    case 0:
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    case 1:
      return bytesToBase64Url(bytes)
    case 2:
      return peerIdFromMultihash(decodeMultihash(bytes)).toString()
    case 3:
      return multiaddr(bytes).toString()
    default:
      throw new TypeError('The share invitation is malformed.')
  }
}

const encodeField = (value: string, preferredTag: number): Uint8Array => {
  let tag = preferredTag
  let bytes: Uint8Array
  try {
    bytes =
      preferredTag === 1
        ? base64UrlToBytes(value)
        : preferredTag === 2
          ? peerIdFromString(value).toMultihash().bytes
          : multiaddr(value).bytes
    if (decodeField(tag, bytes) !== value) throw new TypeError('Noncanonical field')
  } catch {
    // Legacy accepted text and noncanonical representations remain lossless.
    tag = 0
    bytes = new TextEncoder().encode(value)
  }
  const result = new Uint8Array(bytes.length + 3)
  result[0] = tag
  new DataView(result.buffer).setUint16(1, bytes.length)
  result.set(bytes, 3)
  return result
}

const packCapability = (capability: ShareCapability): Uint8Array => {
  const flags =
    Number(capability.ownerPeerId !== undefined) |
    (Number(capability.ownerProof !== undefined) << 1) |
    (Number(capability.expiresAt !== null) << 2)
  const parts = [
    new Uint8Array([capability.v, flags, capability.addresses.length]),
    encodeField(capability.shareId, 1),
    encodeField(capability.secret, 1),
    encodeField(capability.sourcePeerId, 2),
  ]
  if (capability.expiresAt !== null) {
    const expiry = new Uint8Array(8)
    new DataView(expiry.buffer).setBigUint64(0, BigInt(capability.expiresAt))
    parts.push(expiry)
  }
  parts.push(...capability.addresses.map((address) => encodeField(address, 3)))
  if (capability.ownerPeerId !== undefined) parts.push(encodeField(capability.ownerPeerId, 2))
  if (capability.ownerProof !== undefined) parts.push(encodeField(capability.ownerProof, 1))
  const bytes = Uint8Array.from(parts.flatMap((part) => [...part]))
  if (bytes.length > MAX_PACKED_BYTES) throw new RangeError('The share invitation is too large.')
  return bytes
}

const unpackCapability = (bytes: Uint8Array): unknown => {
  let offset = 0
  const take = (length: number): Uint8Array => {
    if (offset + length > bytes.length) throw new TypeError('The share invitation is malformed.')
    const value = bytes.subarray(offset, offset + length)
    offset += length
    return value
  }
  const field = (): string => {
    const header = take(3)
    const length = new DataView(header.buffer, header.byteOffset, 3).getUint16(1)
    return decodeField(header[0]!, take(length))
  }
  const [v, flags, addressCount] = take(3)
  if (v !== 1) throw new TypeError('Unsupported share capability version. Update Constellation.')
  if (flags! > 7 || addressCount! > 4) throw new TypeError('The share invitation is malformed.')
  const shareId = field(),
    secret = field(),
    sourcePeerId = field()
  const expiresAt = flags! & 4 ? Number(new DataView(take(8).slice().buffer).getBigUint64(0)) : null
  const addresses = Array.from({ length: addressCount! }, field)
  const ownerPeerId = flags! & 1 ? field() : undefined
  const ownerProof = flags! & 2 ? field() : undefined
  if (offset !== bytes.length) throw new TypeError('The share invitation is malformed.')
  return {
    v,
    shareId,
    secret,
    sourcePeerId,
    expiresAt,
    addresses,
    ...(ownerPeerId !== undefined ? { ownerPeerId } : {}),
    ...(ownerProof !== undefined ? { ownerProof } : {}),
  }
}

const adler32 = (bytes: Uint8Array): number => {
  let a = 1,
    b = 0
  for (const byte of bytes) {
    a = (a + byte) % 65_521
    b = (b + a) % 65_521
  }
  return ((b << 16) | a) >>> 0
}

const expandCapability = (bytes: Uint8Array): Uint8Array => {
  if (bytes.length < 6) throw new TypeError('The share invitation is malformed.')
  // A fixed buffer bounds allocation even for a malicious compressed invitation.
  const expanded = unzlibSync(bytes, { out: new Uint8Array(MAX_PACKED_BYTES + 1) })
  if (expanded.length > MAX_PACKED_BYTES) throw new RangeError('The share invitation is too large.')
  const checksum = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
    bytes.length - 4,
  )
  if (adler32(expanded) !== checksum) throw new TypeError('The share invitation is malformed.')
  return expanded
}

export const encodeShareCapability = (capability: ShareCapability): Uint8Array => {
  const packed = packCapability(capability)
  const compressed = zlibSync(packed)
  const compress = compressed.length < packed.length
  return new Uint8Array([2, Number(compress), ...(compress ? compressed : packed)])
}

export const decodeShareCapability = (bytes: Uint8Array): unknown => {
  if (bytes[0] === 123) return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  if (bytes[0] !== 2) throw new TypeError('Unsupported share link version. Update Constellation.')
  if (bytes[1] !== 0 && bytes[1] !== 1) throw new TypeError('The share invitation is malformed.')
  const packed = bytes[1] === 1 ? expandCapability(bytes.subarray(2)) : bytes.subarray(2)
  if (packed.length > MAX_PACKED_BYTES) throw new RangeError('The share invitation is too large.')
  return unpackCapability(packed)
}
