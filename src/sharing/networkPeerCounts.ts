import type { NetworkDiagnostics } from './sharingRuntime.ts'

export interface PeerPathCounts {
  readonly direct: number
  readonly viaRelay: number
  readonly both: number
}

export const countPeerPaths = (connections: NetworkDiagnostics['connections']): PeerPathCounts => {
  const paths = new Map<string, { direct: boolean; relay: boolean }>()
  for (const connection of connections) {
    if (connection.status !== 'open' || connection.role === 'other peer' || !connection.peerId)
      continue
    const previous = paths.get(connection.peerId) ?? { direct: false, relay: false }
    // WebRTC negotiated via a relay is a direct WebRTC data connection.
    const relayed = connection.transport === 'relay circuit'
    paths.set(connection.peerId, {
      direct: previous.direct || !relayed,
      relay: previous.relay || relayed,
    })
  }
  return [...paths.values()].reduce<PeerPathCounts>(
    (count, path) => ({
      direct: count.direct + Number(path.direct && !path.relay),
      viaRelay: count.viaRelay + Number(path.relay && !path.direct),
      both: count.both + Number(path.direct && path.relay),
    }),
    { direct: 0, viaRelay: 0, both: 0 },
  )
}
