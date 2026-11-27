# v0.1.5-rc.3 pre-tag release gate

Updated November 27, 2026. This is **release preparation evidence**, not an rc.3 tag or signed artifact. The repository's version metadata remains `0.1.5-rc.2`.

## Scope completed

- Distinct bright-blue own-location GPS marker labeled lowercase `me`, including grouped and oversized-uncertainty presentations.
- Vivid per-follow colors chosen in OKLCH to maximize minimum OKLab separation; dependency-free hue/saturation wheel with brightness and editable hex.
- Color override persistence across reconnects and links with a shared authenticated source or **verified signed owner proof**. Independent unsigned source links remain deliberately unlinkable; never match peers by name, appearance, or unverified metadata.
- `SYSTEM_DEFINITION.csv` tracks those features at `field-validation`. Conditional power/network sharing policies target 0.2; Bluetooth mesh/mailboxes and Taskyon Space announcements/gathering points/location-service features remain explicitly unscheduled.
- rc.3's follow-up adds a shared safe-area-aware dialog layout (`--sheet-safe-top`), an Android status-bar fallback, and viewport-constrained scrolling, with a short-viewport Settings/share-creation regression. `AGENTS.md` now prohibits commits, tags, pushes, merges, and publication without explicit authorization. These changes were committed on 2026-11-27 after explicit maintainer authorization.

## Verified automated evidence

- `corepack yarn ci:preflight` — **PASS** on clean committed `4f1ce1b` **before** the latest uncommitted safe-area and agent-policy edits: immutable install, formatting, TypeScript/lint, 320 unit and 177 script tests, Android configuration, production build, release check, browser suites (sharing 61 pass/1 skip; P2P 25; device comparison 3; onboarding 6; map UI 44; diagnostics 9 pass/3 skips), Pages and screenshot generation. The working-tree changes must be tested again after an explicitly authorized commit before claiming clean-commit readiness for rc.3.
- New signed-owner color persistence regression in `src/sharing/sharingRuntime.test.ts` reproduced the original bug (**red**) and passed with the fix (**green**), including rejection of unrelated unsigned links and forged owner proofs.
- `corepack yarn playwright test tests/map-ui.spec.ts --workers=1` — **46/46 passed** on the latest uncommitted CSS/View/test changes, desktop and mobile, including own-location marker/grouping and safe-area Settings/share-creation geometry.
- On the uncommitted changes, Prettier, `corepack yarn typecheck`, and `corepack yarn test:scripts` (**177/177 passed**, including system-definition CSV validation) all passed.
- `corepack yarn playwright test tests/p2p-share.spec.ts --project=desktop --workers=1` — **25/25 passed** on committed `64cabf9` after the signed-owner color fix, and again in the clean preflight.
- `corepack yarn release 0.1.5-rc.3 --dry-run` — PASS on clean `64cabf9`; previews the metadata bump without changing any files or tagging.
- A `share-flow.spec.ts` run initially had 60 passes, one intentional skip, and a desktop Add peer click timeout. The case passed in isolation, then a complete non-overlapping run passed 61/61 with one intentional mobile skip. Diagnostics' original full-load navigation timeout was fixed to use DOMContentLoaded; the full diagnostic suite subsequently passed.

## Integrity and environment limits

An earlier `ci:preflight` run completed the quality phase and the sharing UI checks (**61 passed, 1 intentional mobile skip**) but exited 129 during live P2P after another process changed HEAD. A separate P2P run was contaminated by a concurrent `ci:quick` rebuilding vendored Taskyon `dist/` files and returned 24/25; its failed approval test then passed alone. The clean non-overlapping P2P run passed 25/25. Do not treat either contaminated run as a reproducible application failure or the aborted preflight as an overall green gate. Never run vendor builds concurrently with Vite/Playwright in this checkout.

Native Kotlin/JVM tests passed using cached SDK/JDK17. A fresh x86_64 Android debug APK was built from the **uncommitted rc.3 candidate** with Rust 1.95, an x86_64 host GCC wrapper and the Android NDK; the retained APK is in `dist/constellation-android-debug-x86_64.apk` and is **not signed as a release**. API36 managed smoke passed (including lock, return-share, process recovery and text intake). Two-emulator single-viewer comparison initially encountered a WebView CDP timeout, then passed independently with verification letters, consent and authenticated receipt.

A first 15-case Android matrix reached **13/15 passed**: both API29 entries could not launch because their system images were missing from the selected SDK. A separately cached API29 Play SDK and a freshly isolated API29 AOSP/no-GMS image corrected the environment; the API29 Play and AOSP native smokes **each passed independently**. The subsequent full matrix did pass API36 and API29 Play, but **API29 AOSP crashed** while operating the peer UI: a disappearing app process and GPU-thread SIGABRT/SIGSEGV signatures involving `libwebviewchromium.so` and `libhwui.so`. This intermittent failure is **not release-clearance evidence**; investigate whether it is emulator/renderer-specific and require physical-device confirmation. The subsequent full-matrix run and final case counts should be recorded when complete. Native status-bar/cutout UI, 24-hour battery, and real-phone acceptance remain outstanding.

## 2026-11-27 field feedback and uncommitted follow-up

Two real-device logs show multiple `sharing.share.create.failed` events while Android reports network online. The former share creation path waited on a relay reservation and rejected when no reachable P2P address was available. Native journal reports only generic success/error, which is insufficient to diagnose a particular carrier or relay outage. New UI diagnostics retain a redacted error reason; never log a link secret or peer identity.

- Generate the Ed25519 source identity and encrypted share capability while offline, persist it before starting P2P, and present QR/copy immediately. A relay hint lacking a relay peer ID is resolved when the recipient connects; authenticated source/recipient validation remains mandatory. Background recovery retries asynchronously and link lifecycle/expiry remains authoritative.
- Make share creation errors persistent in the dialog and make the ready-link screen distinguish saved-but-disconnected from active.
- Android requested background network-position cadence: 1/5/10 min, default **5 min**, with passive location updates for movement at least 50 m _subject to position accuracy_. Stop ongoing samples when there is no connected viewer. Authenticated active viewing can request responsive 15 s updates with a source-controlled 10 min boost budget per rolling 20 min; prefer network location when hidden, with GPS fallback only under Automatic when no network provider exists. Android may defer location callbacks, so the interval and distance are requested behavior, not a delivery guarantee.
- Existing event-driven reconnect on network changes and bounded background recovery are retained; synchronized fixed wake windows and forced disconnects were **not** enabled. Two independent sleeping phones cannot guarantee overlapping windows under Doze; evaluate staggered windows, randomized backoff, and encrypted mailbox/rendezvous support separately before turning off the only available connection.
- The native Kotlin/JVM unit tests and browser TypeScript/unit tests passed after the native policy change. The offline-payload relay hint regression and authenticated browser P2P session passed. The full working-tree browser suite and API36 native APK smoke results are recorded below; physical acceptance remains pending.
- The follow-up changes were committed on 2026-11-27 after explicit maintainer authorization; no tag, release or push was authorized.

## 2026-11-27 current working-tree automated verification

**Completed without committing or tagging:**

- `corepack yarn ci:quick` passed: immutable install, formatting, TypeScript, lint (warnings only), vendored and application unit tests, **178 script tests**, Android configuration, production build and release metadata consistency. Focused `android-v015-reliability.test.mjs` checks also passed after enabling the network fixture for API36; the amended fixture invocation is rechecked by the final script validation.
- Serialized Playwright release suites passed, with no concurrent vendor rebuild: **sharing UI 63 passed / 1 intentional skip** (includes offline creation and default/custom interval); **P2P 25/25**, **device comparison 3/3**, **link onboarding 6/6**, **map UI 46/46**, **sharing diagnostics 9 passed / 3 intentional skips**. **Pages preflight** and the **three synthetic browser screenshots** also passed.
- Native Gradle `:tauri-plugin-constellation-android:testDebugUnitTest --offline` passed, including a regression that verifies the ten-minute active boost returns to saver mode within a rolling twenty-minute budget.
- Rebuilt `dist/constellation-android-debug-x86_64.apk` and passed the **API36 managed sharing smoke** from that debug APK: browser viewer, network-location background and locked-screen updates, scoped automatic return share, process recovery and incoming text intake. The emulator needs an explicitly synthetic `NETWORK_PROVIDER` test fixture: without it, the network provider was unavailable and the initial smoke correctly reported no location. The test fixture is not shipped in the app. With the default Automatic option, the app can fall back to GPS when network positioning is unavailable; users can explicitly require network-only positioning in settings.
- After the final working-tree changes, `corepack yarn ci:quick` and `git diff --check` passed once more. The x86_64 debug APK was rebuilt after those checks, and its API36 managed smoke passed again against that exact build.
- An additional API29 AOSP/no-GMS rerun was attempted but could not launch: the current SDK does not contain `system-images;android-29;default;x86_64` and `ANDROID_AOSP_SDK_ROOT` is unset. This does **not** resolve or supersede the earlier WebView/GPU crash and is not a device-level pass.
- Existing `ci:preflight` clean-commit check remains **not applicable to the uncommitted working tree**; the equivalent quality and browser parts were run separately. No CI signing or external publication occurred.

**Product limitation:** The five-minute mode is a background _publishing cadence for connected authorized viewers_, not a local history recorder while disconnected. With zero connected viewers the native watch stops; a first viewer subscription requests a new fix. A future opt-in local history/queued-update policy needs separate retention and battery/privacy requirements. Android/Doze does not guarantee fixed five-minute or synchronized P2P wake times.

## Remaining gates before tagging rc.3

1. Keep the committed rc.3 candidate unmodified while it is validated. Do not tag or publish rc.3 without separate authorization.
2. Resolve or qualify the intermittent API29 AOSP WebView/GPU crash, document the complete matrix outcome, and verify native header/cutout layout on an actual Android device.
3. Run `corepack yarn ci:preflight` non-concurrently on the committed candidate revision. It has not been run on that revision yet, so clean-revision readiness is still unproved.
4. Build/sign the rc.3 candidate through the normal release CI; verify the actual artifact on real devices and in the browser, including battery/background behavior.

No tag, push, publication, or signing has been performed as part of this preparation.
