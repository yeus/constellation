# Constellation v0.1.2 — completion agent handoff

**Prepared:** 2026-10-08
**Updated:** 2026-10-11
**Repository:** Constellation checkout (Git `main`, base HEAD when prepared: `97a3f9b add release 0.1.2 requirements`)
**Authority:** `SYSTEM_DEFINITION.csv`, requirements **208–228**; `AGENTS.md`; `docs/V0_1_2_IMPLEMENTATION_STATUS.md`.
**State:** The implementation commits are on `main`: `837c86c` and `d3d9900`; this update records their canonical requirements and release evidence. Metadata remains `0.1.1-rc.3`. No v0.1.2 version bump, tag or release exists. The maintainer plans to bump to `0.1.2-rc.1` and test after this commit sequence.
**Purpose:** Hand off the remaining committed-tree verification, physical-device acceptance, and release readiness.

## 0. Mission and mandatory operating rules

The implementation and emulator/browser work packages below are complete to their recorded evidence. Continue with the committed-tree preflight, preserve the remaining acceptance gaps, and update this file and the canonical system definition if new evidence changes their status.

1. Start with `AGENTS.md` and **all** v0.1.2 rows 208–228 of `SYSTEM_DEFINITION.csv`. Then read `docs/V0_1_2_IMPLEMENTATION_STATUS.md`, `docs/DEVICE_COMPARISON_SECURITY.md`, `docs/VERY_SHORT_LINK_DESIGN_REVIEW.md`, and `docs/DEVELOPMENT.md`. Inspect each owner and its tests before editing.
2. **Preserve user work.** Record `git status --short` and `git diff --check` before edits. Do not reset, clean, checkout-overwrite, squash, release, create tags, push, or discard unrelated changes. Avoid packaging screenshots or generated secrets in source control.
3. For a behavior change: first reproduce it with the **smallest test appropriate**, then add or update **one focused regression** before implementing the fix. Update the affected `SYSTEM_DEFINITION.csv` row in the same change. The repository defines statuses precisely: `planned` = criteria not met, `implemented` = behavior exists without maintained focused test, `tracked` = acceptance met plus maintained workflow test. Do not falsely mark native/multi-device acceptance complete based only on browser emulation.
4. **No test inflation.** Extend existing suites/fixtures and use table-driven unit cases where useful. Do not write a new unit test when existing protocol, crypto, or persistence tests already prove the same invariant. Favor a small number of real browser P2P E2E tests and a targeted Android managed test over parallel mock-based suites.
5. Preserve **local-first/private P2P semantics**. Do not merge people/peers based on names, colors, fingerprints, or inferred proximity. Do not store more accurate coordinates, export secret keys, persist bearer links in stop-notice retry queues, or emit capabilities, precise coordinates, private IDs or addresses in diagnostics/fixtures/logs. A share may have multiple recipients; link ID is not automatically a person ID. Maintain the distinct native Android source identity vs foreground owner proof.
6. Taskyon-owned generic protocols/packages remain upstream-owned. No sibling-workspace imports, no new competing wire protocol or arbitrary changes to `vendor/taskyon`. Treat optional unsupported v0.1.2 RPCs as optional, never as implicit location authorization.
7. Run targeted checks immediately after each slice. At final verification run the actual CI-equivalent commands and state plainly what was **not** run. Use `--workers=1` for relay-backed Playwright; do not “fix” a failure by raising all timeouts or loosening expectations.
8. **Release policy:** Complete all implementation/verification and produce a release-readiness report. Do **not** independently bump/version/tag/push/release or use signing secrets without explicit maintainer authorization. If external Android/device/CI verification is inaccessible, leave release acceptance `planned`, write precise reproducible instructions and failure evidence, and report the blocker.

## 1. What is established vs not established

### Execution evidence as of 2026-10-08

The following supersedes the original audit baseline and stale-selector failures.

| Package          | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Remaining acceptance                                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| A / 210          | Fixed authenticated per-recipient ended history, bounded protected persistence, legacy fallback and common-list grouping. Focused real P2P history regression passes.                                                                                                                                                                                                                                                                                                                            | Native presentation                                                                                                                        |
| B / 209–215      | Shared compact navigation; same-name identity separation, reciprocal return sharing, independent links, filters and collapsed keyboard map focus exercised in browser workflows.                                                                                                                                                                                                                                                                                                                 | Complete mobile accessibility and native WebView acceptance                                                                                |
| C                | All **16 original P2P scenarios plus one focused history scenario pass: 17/17 desktop**, single worker, no skips. Obsolete selectors and stale assertions corrected.                                                                                                                                                                                                                                                                                                                             | Native interoperability                                                                                                                    |
| D / 219, 222–227 | Offline explicit-stop/restart/dismissal workflow passes with two real sources, one saved follow and one unsaved preview. Synthetic return form exposes foreground/background options. Narrow synthetic map fixture verifies transparent contained avatars, all-six overflow membership and canonical area fit.                                                                                                                                                                                   | Common-list overflow and dock reset pass with real synthetic P2P sources and controlled map height; physical safe areas remain unverified  |
| E                | **2026-10-09:** project flake toolchain (Node 22, Rust, JDK17, Android SDK/adb, emulators) is available in the sandbox. x86_64 and arm64 debug APKs build. Managed API 29 and API 36 full flows pass, plus three-way browser/Android/Android, no-GMS, reboot, notification-stop, permission-denial, expiry, foreground-only, multi-link, power/network, service-restart, native-fallback, UI-policy, captive, restricted-start, metered, direct-transport, stop-notice and project-links smokes. | Physical-device lock/Doze/battery and signed App Links deployment remain unverified; direct-transport and project/release-link smokes pass |
| F                | Quick CI passes: 15 vendor, 196 app and 101 script tests; lint, formatting, web build, Android config and release metadata. Pages passes after migrating its stale boot selector. Screenshots pass and all three PNGs were inspected.                                                                                                                                                                                                                                                            | GitHub Actions and committed-checkout preflight not run                                                                                    |

Completed browser runs: sharing **26/26** (13 desktop + 13 mobile), map **30/30** (15 + 15), device comparison **2/2 desktop**, P2P **17/17 desktop**. Diagnostics: 7 passed, 3 intentional mobile skips. Exact final commands and limitations are listed in `V0_1_2_IMPLEMENTATION_STATUS.md`.

The historical P2P single-recipient timeout came from removed navigation. The full suite now uses `tests/fixtures/peer-navigation.ts`. The preview test retains deferred GPS until saving and proves saving alone publishes no return share. The authenticated-stream test waits for its actual connected viewer before revoking, rather than assuming a reloaded page has already reconnected.

Native background Share-back now uses actual service availability (`Boolean(backgroundSharing)`), and the real ShareSheet browser fixture verifies both publication choices while hiding the unrelated Star viewers option. This is UI evidence, not native execution evidence.

**2026-10-09 native continuation:** the previous Android return failure was diagnosed to the owner-proof identity split: native-created source links carried the background service identity, but approved returns are received by the distinct foreground identity, so the browser's return link pre-bound to the source identity denied the foreground dialer (`approved=true match=false`). The foreground now signs the original link owner proof and the native source verifies and persists it before the link is presented, using the same proof-only handoff as return links; the source key and foreground owner identities stay separate. The generalized `replace-background-owner` command covers source shares (no recipient binding) and return shares (single-recipient binding), with idempotent retry, forged-proof rejection and already-handed-off rejection. Managed API 29 and API 36 flows now deliver and acknowledge returns; a three-way two-Android-plus-browser run passed; the full smoke matrix passed, including the direct-transport smoke once its missing viewer-approval setup was fixed and the new Android stop-notice lifecycle smoke (ordinary disconnect produces no notice; explicit offline stop delivers one durable record; dismissal persists across restart). See `docs/V0_1_2_IMPLEMENTATION_STATUS.md` for exact commands and evidence.

**Release acceptance remains planned.** Commits `837c86c` and `d3d9900` are on `main`; no version bump, tag, signing or publication occurred. Requirements 210 and 222 have maintained real-browser regressions; 224 and 226 have focused browser component regressions. Requirement 225 is now tracked by the same map scenario: two real synthetic P2P sources, controlled map height, filtered common-list membership and normal dock restoration. Requirements 211/219/221 and native acceptance retain their stated gaps.

## 2. Work package A — COMPLETE known implementation gap: ended history by authenticated peer (210)

**Priority: P0; do this first.**
**Owning paths:** `src/components/PeerListSheet.vue` (~lines 426–557), `src/sharing/sharingRuntime.ts` (`OldShareSummary`, lifetime capture and `stopShare`), `src/sharing/privateStore.ts` (`LifecycleRecord`), `src/views/MapView.vue` (`oldSharing` and `oldSeeing`), existing tests `src/sharing/sharingRuntime.test.ts`/`src/sharing/privateStore.test.ts`.

### Original failure mechanism (now fixed)

The UI groups **active** outgoing viewers using authenticated `viewer.peerId` (or a scoped connection fallback) but groups **ended outgoing links** at `getEntry('share:' + ended.shareId)`. `OldShareSummary` supports an optional `peerId`, but the outgoing `oldSharing` creation paths around expired-restoration and `stopShare` save only the share ID, name, reason and time; the UI's `oldShares` prop currently does not expose `peerId` at all. A relationship from a still-active peer thus ends in a separate link-level row instead of that peer's history. An outgoing share may have **multiple distinct viewers**; assigning the entire historical share to one viewer would be a security/identity misrepresentation.

### Required behavior

- Persist and expose **authenticated recipient-specific history when it actually exists**, while retaining **share-level link history** when viewer identity was never known or a link applied to multiple people. Do not assert a one-to-one relationship when evidence only says “share link”.
- For known authenticated peer(s), merge historical **relationship(s)** with matching active peer row(s); show correct direction, per-link reason `expired`/`revoked`, timestamps and independently actionable remaining links.
- Preserve distinct peers with the **same displayed name**, private nicknames, link ownership, and all active relationships. Unclaimed/waiting links remain separate unless later safely associated.
- `Show ended` is off by default: hide ended-only entries while keeping ended relationships of still-active peers available _within_ that row; when enabled show ended-only peers/link history. Direction filters `All`, `Sharing`, `Viewing`, `Both` should behave per the canonical requirement, even for mixed active+ended records.
- Respect current 128-record bounded storage and backward-compatible protected-state decoding. Old records with missing optional peer identity must still load and appear honestly. Do not rehydrate ended shares into live location streams or grant access.
- Maintain stop-notice dismissal semantics: undismissed `Stopped following` stays visible by default and dismissed entries remain discoverable under `Show ended`. Do not infer explicit stop from disconnect or expiry.

### Implementation delivered

`SourceShare.viewerPeerIds` retains bounded authenticated recipients in protected storage. Lifecycle records key each relationship by share and optional peer identity; unknown/legacy records remain link-level. The common list groups known history by authenticated peer and MapView retains foreground/background relationship keys. Failed persistence rolls state back. Existing runtime/store regressions and the focused P2P workflow cover identity separation, multi-viewer links, active/ended controls, filters and reload.

### Original implementation guidance

Inspect `ShareSummary.viewers`, `OldShareSummary`, `LifecycleRecord` and saved native/background summaries. A possible solution is a bounded, authenticated **per-peer relationship history** alongside the existing link history, with explicit schema and migration/legacy fallback; choose the smallest correct design, not necessarily that particular structure. Avoid duplicating sensitive state for convenience. Do not try to fix the issue by simply adding the last viewer ID to every `oldSharing` record.

### Minimum tests / acceptance

Use **one focused history/grouping scenario**, with compact subcases (existing runtime/store tests can cover persisted metadata instead of adding separate suites):

1. Share A from source to peers P and Q; end A; source still shares/follows P via link B. P's row contains A's relevant ended relationship and B's active controls; Q's history remains separate. Neither is guessed from a display name.
2. Another peer R has the same display name as P: **do not merge**.
3. Unknown/unclaimed or legacy historical link remains a truthful separate link-level history, not silently attributed to P.
4. Toggle `Show ended`; exercise direction filters and dismiss; restart, reload protected state and confirm reason/time/identity are stable.
5. Verify 0.1.1 stored records lacking new optional fields continue decoding and do not gain false associations.

**Done when:** case verified by focused automation, no identity leaks/duplicate relationships, row 210's `verification` and status accurately updated.

## 3. Work package B — COMPLETE / ACCEPT compact reciprocal peer UI (211 plus 209/212–215)

**Priority: P0; after A, before broad browser suite.**
**Owner:** `src/components/PeerListSheet.vue`, `src/components/PeerAvatar.vue`, `src/views/MapView.vue`, `src/styles.css`.

Inspect rather than assume defects; fix only failures you reproduce. Reuse the grouping fixture from A, not a second parallel E2E suite.

Acceptance matrix:

- **Outgoing only:** collapsed avatar + consistent displayed name + “Sharing” and meaningful waiting/connected status. An unclaimed share displays an accessible **hourglass**, not initials made from “Waiting for a viewer”.
- **Incoming only:** collapsed peer “Viewing”, correct live/delayed/stale/unavailable status and independent `Keep following`, `Stop following`, `Show on map` actions.
- **Reciprocal:** one authenticated peer row with “Sharing and viewing”; expandable **distinct outgoing/incoming links**. A link-specific stop, revoke, block, name or color action must not destroy another relationship.
- **Multi-link:** repeated shares with same **authenticated** peer collapse into one row and retain separate controls; peers with merely equal names do not.
- **Ended relationships:** respect A and stop-notice behavior.
- **Collapsed map action (212):** keyboard-accessible, not requiring row expansion; map fits _disclosed_ uncertainty area(s), not invented precise coordinates; disabled explanatory state when unavailable; map camera remains intact after closing.
- **Menu/dock:** `Sharing N · Seeing M` opens `Peers` in `All` filter. `Add peer` and `Share location` are header actions. Menu expands/toggles/closes by Escape/outside click, preserves toggle focus and respects reduced motion.
- **Accessibility:** verify keyboard summary activation, focus behavior, button nesting and labels at common mobile viewport widths. In particular inspect the **button currently nested inside `<summary>`** for keyboard behavior and semantic ambiguity; fix if it actually produces bad interaction rather than launching a large redesign.

**Tests:** Add compact assertions to the focused A test and existing `tests/share-flow.spec.ts`/`tests/map-ui.spec.ts`. Do not produce a new suite for every icon/filter/button. Maintain normal precision/privacy constraints.

**Done when:** no known UI functionality gap remains for 211 and related requirements, focused evidence is recorded, no unexplained mobile layout clipping or keyboard regression.

## 4. Work package C — REPAIR and RUN the entire EXISTING P2P browser suite (no redundant tests)

**Priority: P0, before writing more end-to-end scenarios.**
**Owner:** `tests/p2p-share.spec.ts`, `tests/fixtures/two-sources.ts`, `tests/fixtures/share-probe.ts`, and associated app code only if a real behavior defect is exposed.

### Navigation migration completed

All obsolete navigation in this suite and its fixtures was migrated to the actual compact dock/common list using shared helpers. No production compatibility buttons were added. The existing preview-save and blocked-admission assertions now follow current behavior. The authenticated-stream case explicitly waits for reconnection before testing immediate online revocation.

### All 16 existing scenarios to preserve and run

1. Opted-in names and private reciprocal nicknames.
2. Revocation during admission preserves ended history.
3. Private peers never use public discovery.
4. Sender approval gates first viewer; forwarded second device is denied.
5. Return consent applies to all viewers of the same original link (and only that link).
6. QR invitation scan and preview.
7. Very-coarse location discloses only the intended 20 km uncertainty.
8. Preview is not persisted until Keep following.
9. Each link gets distinct persistent source identity.
10. One-viewer capacity and isolation.
11. Actual browser location flows over authenticated P2P stream, revocation, source/viewer behavior.
12. Block one viewer while retaining another, including source reload.
13. Two independent sources; stop one follow without losing the other.
14. Independent links from same source have unlinkable peer identities.
15. Revoke active share, immediate removal and history.
16. Offline viewer learns revocation after source restart.

All sixteen original scenarios and the added authenticated-history scenario passed in the final single-worker desktop run (17 passed, 5.6 minutes, no skips). Earlier diagnostic runs exposed obsolete assertions and a missing online precondition; those were corrected without suppressing behavior or raising global timeouts.

### Run and triage

```sh
corepack yarn build:vendor
corepack yarn exec playwright test \
  tests/p2p-share.spec.ts --project=desktop \
  --workers=1 --reporter=line
```

- Fix test-only obsolete selectors as test changes; **do not suppress assertions or skip** behavior to obtain green.
- If a test now genuinely fails in app logic, reproduce with focused fixture, add a minimal regression if existing test doesn't already specify it, fix the owning source and rerun.
- If P2P relay startup intermittently fails, examine `scripts/e2e-relay.mjs`, `src/sharing/browserPeer.ts` and the relay address/reservation lifecycle using privacy-safe diagnostics; do not hide a systematic failure with arbitrary 180-second timeouts.
- Close contexts and stop peer runtimes reliably without letting `finally` mask the primary failure.
- Run all five configured browser suites under CI's concurrency, including mobile where configured. Don't duplicate P2P multi-peer desktop flows for a simulated mobile browser without a mobile-specific reason.

**Done when:** **16/16 existing P2P desktop scenarios pass**, all five browser regression suites pass with CI settings, or each genuinely blocked case has root cause/evidence and remains explicitly open.

## 5. Work package D — MINIMAL genuinely missing browser acceptance

**Priority: P0/P1 after C.**
Write **no more than these three focused browser scenarios unless a newly reproduced defect justifies another**. A/B should already provide the first.

1. **Peer relationship/history (210/211):** as specified in A/B; share active+ended state, authenticated identity separation, filters, hidden/dismissed history and reload. Do not separately retest cryptographic HMAC or first-device concurrency here.
2. **Stop explicitly while sender offline and deliver on reconnection/restart (222):** use two actual browser P2P identities via existing local relay. Establish live follow, make sender truly unreachable, tap Stop following (including an **unsaved preview** if low-cost), confirm viewer UI returns promptly and local follow disappears. Restart sender and viewer/reconnect, prove exactly one authenticated `Stopped following` notice with an event timestamp appears, survives persisted reload, dismisses into ended history, and never creates location access or extra links. A plain disconnect/timeout **must never** generate stop history. Validate privacy without logging URL secrets. Prefer one E2E with phases over many brittle disconnected-state tests. Current local unit tests already prove derived HMAC, bounded 7-day queue, 16-event replay ledger, rollback and dedupe—**do not clone them**. A permanently offline sender cannot receive a notice; report honest eventual-delivery limits.
3. **Oversized uncertainty area/avatar stack (223–227):** synthetic disclosed areas and camera states via existing map fixture. Verify the **transparent lower-left avatar-only column**, correct initials/accessibility and grouping, no clipping or collision at narrow viewport, ellipsis when many peers, overflow into **same** filtered peer list with all represented peers, restoration to normal unfiltered list on dock open, and clicking an avatar zooms to fit its own disclosed area (not an exact point/detail panel). Check navigation-control size, bottom attribution and mobile safe area. One scenario with a few controlled fixture states is enough; do not add pixel snapshots of every zoom level.

Also **extend one already existing** share UI test or native boundary/unit test for the newly corrected **Android Share-back background choice**: the background option is available when background service exists and a return recipient is selected; foreground choice remains available, and sender-only recipient binding remains invariant. Browser-only `Pixel 5` user agent is **not** proof that the Tauri Android bridge exists. Avoid adding generic snapshots of every form option.

**Done when:** all three focused acceptance areas are covered in regular CI suites; new fixtures remain synthetic and privacy-safe; no unrelated test proliferation.

## 6. Work package E — NATIVE Android build, automated integration and real-device acceptance

**Priority: P0 for release, not optional.**
Owner: `flake.nix`, `docs/DEVELOPMENT.md`, `scripts/test-android-managed.mjs`, `scripts/test-android.mjs`, `src/android/backgroundEntry.ts`, `src/android/backgroundSharing.ts`, `src/android/backgroundRuntimeStatus.ts`, `src/android/backgroundReturnCommand.ts`, `src-tauri/src/lib.rs`, Android Kotlin plugin/service.

**Status 2026-10-09:** E1 is complete in the sandbox (both debug APK targets build; managed flows and smokes pass; see `V0_1_2_IMPLEMENTATION_STATUS.md`). E2 automated emulator acceptance is complete, including the direct-transport smoke and native project/release links. The physical-device checklist below remains open.

### E1: Provision and compile

1. Check `nix --version`, `nix develop`, shell tool paths and whether Nix has necessary store/network access. The documented `nix develop` shell supplies Node 22, Rust, JDK17, Android SDK/NDK, adb and emulators **if it can be instantiated**.
2. Once provisioned, run `corepack yarn build:android:background-runtime`, `corepack yarn test:android:config` and **compile the native app**: `corepack yarn build:android:debug:x86_64-emulator` (and `...:arm64-device` when available). Surface **Rust/Kotlin/Gradle errors** and fix real source defects. Do not claim native success from Vite JavaScript compilation alone.
3. Prefer the existing scripts, not a new Android E2E framework:
   ```sh
   corepack yarn test:android:managed
   corepack yarn test:android:managed \
     --local-share-flow
   corepack yarn test:android:three-way
   ```
   Additional specific existing flags are documented in `scripts/test-android-managed.mjs` such as `--service-restart-smoke`, `--permission-denial-smoke`, `--notification-stop-smoke`, `--power-network-smoke`, `--direct-transport-smoke`, `--reboot-smoke`, `--compat-only` and `--no-gms-smoke`. Select **relevant** ones first; don't run every platform variant redundantly when unchanged.

If unavailable (Nix store, emulator virtualization, device permissions, missing SDK, blocked network), capture exact blocker and distinguish **not run** from **failed**. Don't pretend tests were executed.

### E2: Targeted v0.1.2 acceptance on emulator/real devices

Reuse the managed Android test harness; extend it with **one integrated native return-share scenario** and compact checks where necessary:

- **219 permission-first return and background sharing:** original sender A and viewer B have distinct authenticated device/source identities. A creates original link; B saves/approves return reception separately from network availability; B chooses Share back → normal creation form → **In background**, duration/precision, only original sender targeted. Native bridge must verify signed foreground owner proof, atomically persist intended recipient, handle lost acknowledgement idempotently, reject a forged/different-recipient proof, and not send/location-publish before authorization. Lock/background B; A alone receives updates. Restart/stop/expiry/revocation remain correct.
- **221 optional four-letter comparison:** manual approval + first-device-claim paths; identical letters and owner/transcript on both devices; not auto-verified; mismatch/cancel/restart budget. Background source/foreground viewer transitions and unavailable old-client RPC must fail closed, not bypass admission. Human trusted-channel comparison (e.g. reading letters on two phones) is physical acceptance, not claimable from matching machine values alone. Security design remains described in `docs/DEVICE_COMPARISON_SECURITY.md` and would benefit from independent review; do not claim formal proof.
- **222 stop notice:** stop while one Android service/viewer is offline, reconnect/restart, one durable UI notice, dismissal retained; ordinary heartbeat/network loss no “stopped” event. Android's process killing/battery restrictions may delay retries; make UX explicit rather than asserting guaranteed delivery.
- **216 project/release links:** Android menu opens exactly allowlisted GitHub destinations via `ACTION_VIEW`, without arbitrary URL escalation. When no browser is installed, show safe failure and keep app working.
- **210–215 / 223–227 UI:** inspect native WebView narrow viewport, keyboard/safe areas, compact peer UI, menu and map avatar stack. Browser mobile emulation is useful preliminary evidence but **not** enough.
- **228 diagnostics:** distinguish Direct, Via relay, Both across active peers, foreground vs background; do not confuse relay infrastructure with application peers or expose IDs by default.
- **Interop:** browser ↔ Android and (if possible) Android ↔ Android. Unsupported optional features must degrade without breaking established location shares.

**Physical-device acceptance that cannot be simulated faithfully:** lock screen, foreground-service notification and Android background-location permission flow, Doze/battery restrictions, app process death/restart, external default browser behavior, and actual network changes. Provide a finite **manual checklist with pass/fail and device/API version**, not a generic “test on device” note. When real hardware unavailable, report release as blocked and do not set affected criteria `tracked`.

## 7. Work package F — Screenshots, Pages, CI, release readiness

**Priority P1, after features are accepted.**

1. `tests/screenshots.spec.ts` currently clicks obsolete top-level `Share location` and older `Following (2)` nav. Update it to the same compact dock/peer filter as C; preserve synthetic locations `River`/`Forest`, no capabilities/QR/precise real coordinates in screenshots. Use `corepack yarn screenshots`; inspect rendered output and ensure it captures the current UI. Avoid committing generated screenshots unless existing release workflow explicitly requires it.
2. `corepack yarn test:pages` to validate SPA fallback, public URL and fragment secrecy (it is **not included** in `corepack yarn test`).
3. Full web regression aligned with `.github/workflows/ci.yml`:
   ```sh
   corepack yarn format:check
   corepack yarn build:vendor
   corepack yarn lint
   corepack yarn test
   corepack yarn test:android:config
   corepack yarn build
   corepack yarn build:android:background-runtime
   corepack yarn exec playwright test \
     tests/share-flow.spec.ts --workers=1
   corepack yarn exec playwright test \
     tests/p2p-share.spec.ts --project=desktop \
     --workers=1
   corepack yarn exec playwright test \
     tests/device-comparison.spec.ts \
     --project=desktop --workers=1
   corepack yarn exec playwright test \
     tests/map-ui.spec.ts --workers=1
   corepack yarn exec playwright test \
     tests/sharing-diagnostics.spec.ts \
     --workers=1
   corepack yarn test:pages
   corepack yarn screenshots
   git diff --check
   ```
   `corepack yarn test:e2e` is an alternative combined runner once stable, not an _additional_ independent suite. Explicitly account for intended desktop-only skips in mobile.
4. `corepack yarn ci:quick` works with dirty worktree. **Do not run `corepack yarn ci:preflight` expecting a pass while dirty**: it intentionally requires a clean, committed checkout and checks HEAD immutability. After explicit authorization for a commit, run the full CI preflight and confirm GitHub Actions on the eventual commit. Never claim Actions passed just because sandbox tests passed.
5. Review release metadata via `corepack yarn release:check` and `corepack yarn release --help` / dry-run options where available; **do not change versions, commit, tag, sign or publish** without explicit user direction. Preserve 0.1.1 historical evidence and update only current rows according to `AGENTS.md`.
6. Update `docs/V0_1_2_IMPLEMENTATION_STATUS.md` and this handoff with exact commands, passed/failed/skipped, native environment/device types, known limitations and unresolved blockers. The very-short URL scope in v0.1.2 is **only the architecture/security review already recorded in `docs/VERY_SHORT_LINK_DESIGN_REVIEW.md`**; do not invent or deploy a resolver.

### Final acceptance contract / release gate

Do not call v0.1.2 complete unless:

- [x] Requirement 210 authentic peer/history association and 211 reciprocal/multi-link behavior are correct and covered (browser regressions plus Android WebView workflows). The broader 211 compact-row presentation/accessibility row remains `planned` under the physical-device/accessibility gates.
- [x] Existing **16/16** P2P browser tests pass with updated selectors (not skips), and the other configured browser suites are green.
- [x] The three focused missing browser acceptance scenarios are present without redundant crypto/protocol tests.
- [ ] Mobile narrow-layout, collapsed map focus, area-avatar overflow and controls pass actual UI acceptance. (Browser and WebView automation pass; physical safe areas remain open.)
- [x] Native Android Kotlin/Rust APK builds and relevant managed E2E pass (emulator, 2026-10-09), including direct transport and project/release links; release remains `planned` for the physical-device gates.
- [x] Android return background sharing, separate approval, signed owner, authorized recipient, lock/restart and interop are accepted (emulator); no privacy/authorization regressions observed. Physical lock/Doze remains open.
- [x] Device comparison and explicit stop-notice cross-device lifecycle are accepted without claiming stronger delivery/authentication than designed. (Comparison: browser suite + three-way; stop notice: `--stop-notice-smoke` on API 29/36. Physical human letter comparison and real Doze retry delays remain under the physical-device gates.)
- [x] Android GitHub links and failures and direct/relay counts are verified. (Direct/relay/both counts pass; `--project-links-smoke` covers allowlist rejection, external launch and missing-browser failure on API 29/36.)
- [x] Sandbox tests/Pages/screenshots/quick CI checks are green (GitHub Actions not run); docs and system-definition evidence/status fields are synchronized.
- [x] No new unnecessary tests, dependencies, backends, URL shorteners, insecure stores, logging leaks or hidden release/tag/push activity.

## 8. Incremental agent report format (after every work package)

Report in a small structured paragraph or table:

- **Package / requirement IDs**
- **Confirmed defect vs obsolete test vs unverified condition**
- **Files touched and data/schema/protocol implications**
- **Exact tests run; counts and failures/skips**
- **What remains for next package**
- **Native/CI/manual blocker, if any**
- **Release gate status** (blocked/ready for maintainer authorization)

If blocked, continue with other independent safe tasks and leave a precise reproducible next command. A partial completed package with verified evidence is more valuable than speculative closure. Avoid broad rewrites, duplicate tests, or simply repeating this checklist without implementing it.

## 9. Next actions

Do not restart the completed history implementation or repeat passing suites without a changed behavior or unresolved concern. The native emulator campaign is complete (2026-10-09), including direct transport and project/release links. The maintainer authorized commits on `main`; the next steps are:

1. Run `corepack yarn ci:preflight` on the clean committed tree and record its result. GitHub Actions remains an external check.
2. The maintainer plans to bump the version to `0.1.2-rc.1` and perform additional testing after this commit sequence.
3. Physical Android device: lock screen, foreground-service notification and background-location permission flow, Doze/battery restrictions, process death under memory pressure, external default browser behavior and real network transitions, using the worksheet in `V0_1_2_IMPLEMENTATION_STATUS.md`.
4. Verify signed/deployed App Links association; the sandbox has no release signing fingerprint. Keep release acceptance `planned` until the physical-device gates are met.
