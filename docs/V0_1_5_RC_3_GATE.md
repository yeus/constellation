# v0.1.5-rc.3 pre-tag release gate

Checked November 26, 2026. This is **release preparation evidence**, not an rc.3 tag or signed artifact. The repository's version metadata remains `0.1.5-rc.2`.

## Scope completed

- Distinct bright-blue own-location GPS marker labeled lowercase `me`, including grouped and oversized-uncertainty presentations.
- Vivid per-follow colors chosen in OKLCH to maximize minimum OKLab separation; dependency-free hue/saturation wheel with brightness and editable hex.
- Color override persistence across reconnects and links with a shared authenticated source or **verified signed owner proof**. Independent unsigned source links remain deliberately unlinkable; never match peers by name, appearance, or unverified metadata.
- `SYSTEM_DEFINITION.csv` tracks those features at `field-validation`. Conditional power/network sharing policies target 0.2; Bluetooth mesh/mailboxes and Taskyon Space announcements/gathering points/location-service features remain explicitly unscheduled.

## Verified automated evidence

- `corepack yarn ci:quick` — PASS on the current working tree: immutable install, formatting, TypeScript/lint (10 pre-existing test fixture warnings, zero errors), unit and script tests, Android configuration tests, production build, and version consistency.
- New signed-owner color persistence regression in `src/sharing/sharingRuntime.test.ts` reproduced the original bug (**red**) and passed with the fix (**green**), including rejection of unrelated unsigned links and forged owner proofs.
- `corepack yarn playwright test tests/map-ui.spec.ts --workers=1` — **44/44 passed**, desktop and mobile, including local position marker and grouping.
- `corepack yarn playwright test tests/p2p-share.spec.ts --project=desktop --workers=1` — **25/25 passed** on committed `64cabf9` after the signed-owner color fix, and again in the clean preflight.
- `corepack yarn release 0.1.5-rc.3 --dry-run` — PASS on clean `64cabf9`; previews the metadata bump without changing any files or tagging.
- A `share-flow.spec.ts` run initially had 60 passes, one intentional skip, and a desktop Add peer click timeout. The failing case passed in isolation; a complete second non-overlapping run then **passed 61/61**, with one intentional mobile skip. Clean-commit preflight remains the final gate.

## Integrity and environment limits

An earlier `ci:preflight` run completed the quality phase and the sharing UI checks (**61 passed, 1 intentional mobile skip**) but exited 129 during live P2P after another process changed HEAD. A separate P2P run was contaminated by a concurrent `ci:quick` rebuilding vendored Taskyon `dist/` files and returned 24/25; its failed approval test then passed alone. The clean non-overlapping P2P run passed 25/25. Do not treat either contaminated run as a reproducible application failure or the aborted preflight as an overall green gate. Never run vendor builds concurrently with Vite/Playwright in this checkout.

Cached Nix-store Android SDK, JDK 17, Gradle wrapper, and Rust components were discovered despite missing shell PATH entries. `src-tauri/gen/android/gradlew :tauri-plugin-constellation-android:testDebugUnitTest --offline --no-daemon` with cached JDK/SDK **PASSED** (34 actionable tasks, 3 executed, 31 up-to-date), including the native background runtime build. A full `nix develop` was deliberately stopped because it required thousands of uncached derivations; a current-source APK and two-emulator run have **not** been produced. RC.2's documented two-emulator comparison passed, but its full 15-case Android matrix reached only 14/15 per uninterrupted sweep (see `docs/V0_1_5_RC_2_GATE.md`); intermittent API29 Activity restoration and cold-boot receiver observations remain open. Physical phones and 24-hour battery remain field-validation gates.

## Remaining gates before tagging rc.3

1. Commit the diagnostics navigation regression and catalog/evidence update on a clean revision, leaving the rc.2 tag unchanged.
2. Run `corepack yarn ci:preflight` non-concurrently on that exact clean revision, and record the result.
3. Run the native Android build/emulator and comparison smoke on the same revision in an Android-equipped environment or CI; retain any 15-case matrix failures as documented risks, not silently passed checks.
4. Produce the rc.3 artifact through the normal release CI and perform real-device/browser verification _on that artifact_. Physical field observations belong to rc acceptance and do not retroactively certify the sandbox.

No tag, push, publication, or signing has been performed as part of this preparation.
