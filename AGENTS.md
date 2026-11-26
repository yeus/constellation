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
  - `field-validation`: implemented and available automated checks have passed; only manual alpha acceptance and/or RC real-world field evidence remains. Record the exact pending phase, checklist and evidence in `verification` and `notes`.
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
- Do not create Git commits or tags, push changes, merge branches, or publish releases unless the
  maintainer explicitly authorizes that specific operation. Requests to implement, fix, test,
  finish, or continue work do not imply permission to commit.
- Run the smallest relevant type checks, tests, diagnostics, and formatter checks after changes, and
  report both completed checks and environmental limitations.

Before changing Taskyon-owned packages or protocols, read the matching policies in the initialized
Taskyon repository and update Taskyon's own system definition when that repository changes.

## Release lifecycle: development → alpha → release candidate → stable

For every versioned release, follow this sequence (example target `0.1.0`):

1. **Development (`0.1.0-dev`) — AI implementation and automated acceptance.**
   Finish all in-scope behavior and every feasible automated check: unit, integration,
   security-negative, browser/E2E, emulator, type/lint/static, production build,
   packaging, version consistency and applicable deployment smoke tests. Reuse owning
   tests, fix failures at their source, and rerun affected checks and the release suite.
   Do not hand feasible automated work to the maintainer or silently defer scope.
2. **Alpha (`0.1.0-alpha.1`) — manual pre-RC acceptance.** Only after the automated
   gate passes, prepare an identifiable, installable alpha with a manual checklist,
   setup instructions, known limitations, source/dependency revisions and artifact
   checksums. Alpha is feature-complete for its intended release scope, not an
   unfinished development snapshot. The maintainer tests usability, actual-device
   installation/upgrade, live accounts, recovery and other human-dependent behavior.
   Fix reported defects, add regressions, rerun checks and issue `-alpha.2`, etc.
   Publish rc.1 only after the maintainer accepts the alpha.
3. **Release candidate (`0.1.0-rc.1`) — real-world field validation.** Freeze the
   accepted source and dependency revisions and publish immutable candidate artifacts
   with explicit authorization. Exercise real devices, networks, workloads, lifecycle,
   interoperability and applicable store review for an agreed period. Fix blockers,
   repeat the automated and affected manual gates, and issue `-rc.2`, etc. Never
   replace a published alpha or RC in place.
4. **Stable (`0.1.0`) — promote the accepted RC.** Require maintainer acceptance of
   field evidence and no release-blocking defects. Promote the same reviewed behavior
   apart from version metadata and necessary packaging/signing changes; rerun build,
   version and artifact checks. Behavior changes require another candidate.

Use numbered SemVer prereleases (`-alpha.1`, `-rc.1`), not `-a` or a separate beta
stage. The development label is illustrative; do not change existing version metadata,
release tags or publishing workflows without an explicit task to do so.

### Release evidence

- Record the scope, implementation status, automated results (commands, runner,
  revision, pass/fail/skip counts), manual alpha acceptance and RC field evidence
  separately in the owning system definition/release matrix or equivalent documentation.
  A focused or historical pass is not a current full-suite pass.
- Document inaccessible hardware/services and genuinely external checks. Do not count
  an unrun check as passing, or move a failing feasible automated gate to alpha/RC.
  Reserve checks inherently requiring a released candidate for the RC phase.
- Preparation, successful checks and readiness do not authorize commits, staging, tags,
  pushes or production activation. Preserve existing project-specific requirements.
