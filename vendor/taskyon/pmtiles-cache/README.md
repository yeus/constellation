# @taskyon/pmtiles-cache

Sparse byte-range cache for original PMTiles archives. The cache stores only
bytes the map actually requested, keyed by the original archive offsets, so it
never rewrites a local PMTiles archive after every tile.

- `createPmtilesCachedSource` implements the standard `pmtiles` `Source`
  interface. Partially overlapping requests reuse every locally covered byte
  and fetch only the exact uncovered gaps.
- Coverage is indexed in 64 MiB logical windows of the original archive. A
  window is an address-space partition, not an allocation: a single 16 KiB
  fetch never reserves or downloads 64 MiB.
- New bytes are appended to bounded in-memory segments and published as
  immutable content-addressed blob packs (4–16 MiB target) through a narrow
  record/blob storage port. Per-window sorted interval indexes reference pack
  offsets and are updated with conditional writes.
- The standard PMTiles reader can boot from cached header, metadata, directory
  and tile ranges without contacting the network. Missing bytes fail honestly
  and resume when a remote range succeeds again.
- `createPmtilesHttpSource` validates HTTP status, `Content-Range`, exact byte
  counts and ETags instead of accepting an unexpected full `200` response.
- A scoped Taskyon `StorageClient` satisfies `PmtilesCacheStorage` directly.
  Hosts without the Taskyon runtime may implement the same record/blob
  operations over their existing physical storage.

Cache contents are public basemap bytes only. The package never receives peer
locations, camera history, share material, identities or credentials. Packs are
content-addressed and portable for future authenticated transfer, but this
package performs no P2P discovery, advertisement or publishing.
