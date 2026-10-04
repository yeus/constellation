export const TRANSPORT_KINDS = [
  'relay circuit',
  'WebRTC over relay',
  'WebRTC',
  'WebTransport',
  'WebSocket',
  'other',
] as const
export type TransportKind = (typeof TRANSPORT_KINDS)[number]

export const classifyTransport = (address: string): TransportKind => {
  if (address.includes('/p2p-circuit/webrtc')) return 'WebRTC over relay'
  if (address.includes('/p2p-circuit')) return 'relay circuit'
  if (address.includes('/webrtc')) return 'WebRTC'
  if (address.includes('/webtransport')) return 'WebTransport'
  if (address.includes('/ws')) return 'WebSocket'
  return 'other'
}
