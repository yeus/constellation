# Vendored Taskyon packages

Constellation temporarily vendors complete source snapshots of `@taskyon/protocol` and
`@taskyon/p2p-core` so a fresh checkout remains independently installable before those packages are
released.

- Source repository: Taskyon `frontend`
- Base revision: `b30247b8fd51cfab363424faa045899919182030`
- Snapshot date: 2026-09-21
- Additional upstream working-tree changes: bounded libp2p message-port adapter and its focused
  tests; exact public Zod version for consumer type compatibility; browser-node typing preserves
  libp2p protocol-dial options; optional caller-owned private key for stable peer identity;
  bounded terminal-message flushing before stream closure

Generic changes are made in Taskyon first and synchronized here. Do not patch these snapshots only
in Constellation. Generated `dist` directories are excluded; Constellation builds both workspaces
locally.

The copied packages retain Taskyon's MIT copyright notice in `vendor/taskyon/LICENSE`.
