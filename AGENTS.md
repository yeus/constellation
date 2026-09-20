# Agent Instructions

Read `SYSTEM_DEFINITION.csv` before making any change. It is Constellation's canonical description
of product behavior, architecture, release scope, implementation evidence, verification, milestones,
and known limitations.

When application behavior is unclear, consult the system definition first, then inspect the owning
implementation and its tests. If the intended behavior is still unspecified, ask the maintainer and
clarify the relevant requirement instead of inventing semantics.

## System definition discipline

- Every software change must update the affected row or rows in `SYSTEM_DEFINITION.csv` in the same
  change.
- Keep requirement descriptions, status, surface, Taskyon compatibility, implementation paths,
  verification evidence, milestones, sources, notes, and target releases synchronized with the
  resulting behavior.
- Do not mark a requirement tracked, implemented, or verified beyond the available evidence. Record
  partial coverage and remaining limitations explicitly.
- Treat `target_release` as product scope and `milestone` as implementation order. A prerequisite may
  belong to v1 even when its milestone is `foundation` or `web-preview`.

## Engineering rules

- Trace changes to the highest owning source and fix them there instead of patching symptoms.
- Preserve Taskyon protocol and package ownership. Constellation consumes supported Taskyon packages
  and must not copy their implementations or create competing protocol paths.
- Keep protocols small, typed, versioned, capability-scoped, and independent of transport placement.
- Prefer pure functions, explicit dependency passing, composition, immutable values, and visible
  side-effect boundaries. Keep runtime state out of module scope by default.
- Write or update the focused test before implementation when behavior changes. Use synthetic,
  redacted identities, coordinates, addresses, and paths in tests and diagnostics.
- Never write raw coordinates, bearer capabilities, private peer addresses, keys, or personal
  identifiers to logs, filenames, crash reports, fixtures, or repository artifacts.
- Preserve unrelated worktree and index changes. Do not use destructive Git commands without an
  explicit request.
- Run the smallest relevant type checks, tests, diagnostics, and formatter checks after changes, and
  report both completed checks and environmental limitations.

Before changing Taskyon-owned packages or protocols, read the matching policies in the initialized
Taskyon repository and update Taskyon's own system definition when that repository changes.
