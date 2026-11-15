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
- Use status to show the implementation and acceptance stage, not the feature's importance:
  - `planned`: the requirement has not been implemented.
  - `implemented`: code exists, but runnable automated acceptance checks are incomplete, failing, or not yet maintained. Record the remaining executable checks in `verification`.
  - `field-validation`: implemented and available automated checks have passed; only real-world acceptance on an installed release candidate remains (physical devices, OEM power management, store review, or real networks). Record the specific field checklist and evidence in `verification` and `notes`.
  - `tracked`: all acceptance criteria, including required field validation, are satisfied and maintained focused regression tests run in the regular workflow. Name the tests and runner in `verification`.
- A one-off manual check is useful evidence but does not by itself qualify a requirement as `tracked`. Never use `field-validation` to hide runnable, incomplete sandbox/emulator checks; keep these `implemented` until they pass. Record remaining gaps and platform limits in `notes`.
- Treat `target_release` as product scope and `milestone` as implementation order. A prerequisite may
  belong to v1 even when its milestone is `foundation` or `web-preview`.

## Engineering rules

- Trace changes to the highest owning source and fix them there instead of patching symptoms.
- Preserve Taskyon protocol ownership. Until supported releases exist, Constellation may carry
  complete, provenance-recorded Taskyon package source snapshots under `vendor/taskyon`; generic
  fixes must be made in Taskyon first and then synchronized here without local divergence.
  Constellation never imports sibling workspace source or build artifacts and must not create a
  competing Taskyon wire protocol. Replace vendored workspace packages with released versions once
  they are available.
- Keep protocols small, typed, versioned, capability-scoped, and independent of transport placement.
- Prefer pure functions, explicit dependency passing, composition, immutable values, and visible
  side-effect boundaries. Keep runtime state out of module scope by default.
- Write or update the focused test before implementation when behavior changes. Use synthetic,
  redacted identities, coordinates, addresses, and paths in tests and diagnostics.
- For each reported issue, reproduce it through the simplest relevant path first (unit test,
  desktop dev app, or Android dev app), add a focused regression test, fix the owning cause, and
  rerun that test before claiming it is resolved. Record what remains unproved on real devices.
- If a test or dev-app run fails without enough evidence to identify the cause, add focused logging
  at the owning boundary, reproduce the failure, and use the resulting evidence to fix the root
  cause. Keep logs bounded and redacted; remove temporary instrumentation or retain only useful
  privacy-safe diagnostics.
- Never write raw coordinates, bearer capabilities, private peer addresses, keys, or personal
  identifiers to logs, filenames, crash reports, fixtures, or repository artifacts.
- Preserve unrelated worktree and index changes. Do not use destructive Git commands without an
  explicit request.
- Run the smallest relevant type checks, tests, diagnostics, and formatter checks after changes, and
  report both completed checks and environmental limitations.

Before changing Taskyon-owned packages or protocols, read the matching policies in the initialized
Taskyon repository and update Taskyon's own system definition when that repository changes.

## Release gate: automate to rc.1, then verify on devices

- Every release cycle reaches `-rc.1` using only automated evidence: unit, integration, script,
  browser, emulator, static, packaging, and version-consistency checks. Do not block rc.1 on
  physical-device, OEM, network-handoff, or app-store evidence that cannot be produced
  automatically.
- Test physical devices, real networks, OEM power management, and store review on the rc.1
  artifact itself. When that evidence passes, promote the same source revision for the final
  release instead of changing behavior late in the cycle.
- Before rc.1, implementation with unfinished runnable automated checks remains `implemented`; it cannot be considered ready just because the UI exists. Once available automated tests pass, use `field-validation` if only release-candidate real-world evidence is missing; otherwise use `tracked` if all acceptance is complete. Do not block building rc.1 solely on physical/OEM/store checks that can only be performed on that artifact. Name these limitations in rc.1 notes.
- Record the rc.1 gate evidence (command, runner, result, unproved items) in the owning
  documentation so the promotion decision is auditable.
