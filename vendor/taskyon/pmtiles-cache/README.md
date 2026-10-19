# @taskyon/pmtiles-cache

Tile-aware sparse PMTiles cache with a minimal staged storage port. The cache
stores only tiles requested by the map, keeps them in a valid on-device PMTiles
archive, and fetches misses from the remote archive.

- `createPmtilesCache` serves tiles from a persisted local archive, appends
  misses, rebuilds the archive header and directories, evicts least-recently
  used tiles above `maxBytes`, and invalidates on a changed remote version.
- `PmTilesCacheStorage` is the complete port: read a key, start one staged
  sequential write, commit or abort, and remove a key. Hosts back it with OPFS,
  IndexedDB, or native files without importing Taskyon UI or API packages.
- `createPmtilesArchive` produces spec-v3 archives (127-byte header, root and
  leaf directories, clustered tile data) that the standard `pmtiles` reader
  accepts.
- Cache contents are public basemap tiles. The package never receives peer
  locations, share material, identity, or history.

The staged write rewrites the bounded archive sequentially and publishes it in
one commit. That keeps publication atomic without requiring storage that can
patch or skip ahead; incremental directory patching remains an optimization.
