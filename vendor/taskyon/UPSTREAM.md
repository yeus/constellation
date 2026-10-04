# Vendored Taskyon packages

Constellation temporarily vendors complete source snapshots of `@taskyon/protocol` and
`@taskyon/p2p-core`, plus `@taskyon/diagnostics`, so a fresh checkout remains independently installable before those packages are
released.

- Source repository: Taskyon `frontend`
- Base revision: `b30247b8fd51cfab363424faa045899919182030`
- Snapshot date: 2026-09-21
- Additional upstream working-tree changes: bounded libp2p message-port adapter and its focused
  tests; exact public Zod version for consumer type compatibility; browser-node typing preserves
  libp2p protocol-dial options; optional caller-owned private key for stable peer identity;
  bounded terminal-message flushing before stream closure; protocol envelope construction preserves
  caller-owned strict Zod command and stream-message schemas

Generic changes are made in Taskyon first and synchronized here. Do not patch these snapshots only
in Constellation. Generated `dist` directories are excluded; Constellation builds these workspaces
locally.

The copied packages retain Taskyon's MIT copyright notice in `vendor/taskyon/LICENSE`.

## Diagnostics snapshot

- Package: `@taskyon/diagnostics` (complete source and test snapshot)
- Base revision: `d6477f747db3d4caf4fcd3319a3cc2411b5670b0`
- Snapshot date: 2026-10-04
- Upstream working-tree changes: extract common registry/runner with backward-compatible re-export; propagate parent cancellation to active diagnostics.
- Owner: `frontend/packages/diagnostics`; generated dist is built locally.
