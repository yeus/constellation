# Android standby reliability — v0.1.4 implementation status

## Decisions and release gate

Both `android-incoming-background-reliability` and `android-sender-standby-transport-recovery` remain **planned** release blockers until device evidence confirms them. Product decision: best-effort P2P, bounded automatic recovery, accurate stale/policy status; one off-by-default global **Keep following in background** switch for saved subscriptions; versioned authenticated observation acknowledgement. No claim of delivery during OS-imposed Doze network suspension.

## Implemented: sender-side protocol and recovery foundations

- `src/sharing/shareProtocol.ts`: Constellation sharing v3 (`/constellation/location-share/3.0.0`) adds optional `receipt` to the authenticated `share.heartbeat` request. v2 remains supported; the viewer negotiates v3 first, then v2. Taskyon's generic sensor protocol is unchanged.
- `src/sharing/deliveryReceipt.ts`: immutable bounded pending-observation ledger (16), exact observation validation and monotonic confirmation; rejected, duplicate, or unknown receipts cannot improve delivery status.
- `src/sharing/sharingHelpers.ts`, `sharingViewerApi.ts`, `sharingContracts.ts`, `sharingProjection.ts`: receiver emits latest accepted/decrypted observation metadata only via v3 heartbeat; sender matches against actual session submissions; diagnostics separate local observation, submitted-to-P2P, confirmed-by-viewer, and unsupported older peers. No location coordinates or bearer secrets in receipts.
- `src/android/backgroundRuntimePolicy.ts`, `backgroundEntry.ts`, `sharingLifecycleApi.ts`, `LocationShareService.kt`: native network changes and Doze exit request rate-limited source reconnection, using one coalesced operation that restarts existing source nodes without changing share identities. A protected-WebView watchdog checks unacknowledged v3 observations independently of GPS fixes (90-second stall threshold, 5-minute retry floor), and suppresses retries while native reports no network. Does not request battery exemptions or imply guaranteed Doze operation.
- `src/components/NetworkDiagnosticsSheet.vue`: shows submission/receipt freshness without revealing peer IDs or network addresses unless explicitly requested.

## Implemented: opt-in Android receiver foundation (unverified on device)

- `src/sharing/followOwnership.ts`, `sharingLifecycleApi.ts`, `sharingViewerApi.ts`: serialized Activity/service ownership handoff; Activity viewer leaves sessions without revoking saved links, waits for outstanding protected writes, prevents foreground dials during service ownership, and restores saved follow state before resuming. Native start failures attempt cleanup; a failed release does **not** reopen an Activity viewer.
- `src-tauri/plugins/constellation-android/android/src/main/java/space/taskyon/constellation/plugin/ReceiverOwnershipFence.kt`: encrypted viewer state retains its original Android Keystore identity/alias; synchronized durable ownership/generation fence denies Activity writes while the service owns subscriptions and rejects stale service writes. Outgoing source keys stay in their original separate store.
- `src/android/backgroundViewer.ts`, `backgroundEntry.ts`: second service WebView runtime uses the existing libp2p/crypto sharing API without acquiring GPS. Loads the original viewer identity and restores saved subscriptions. Generation-scoped native state bridge. No bearer URLs/keys in the receiver status projection; revoked, expired, denied and unsaved entries are excluded.
- `ConstellationAndroidPlugin.kt`, `LocationShareService.kt`, `src-tauri/plugins/constellation-android/src/mobile.rs`, `src-tauri/src/lib.rs`: native receiver commands and ownership status. Service keeps an explicit foreground notification and supports separate “Stop background following”. Restart restoration honors the persisted owner fence. The service does **not** claim uninterrupted delivery through OS Doze/network restrictions.
- `src/components/SettingsSheet.vue`, `src/views/MapView.vue`, `src/android/backgroundReceiver.ts`: single Android-only, off-by-default “Keep following in background” switch. Activity reconciles native ownership after foregrounding, displays live/stale received observations from service state, and blocks unsafe subscription writes until Activity ownership returns. Native status validates the generation and observation payloads before display.
- `src-tauri/plugins/constellation-android/android/src/main/AndroidManifest.xml`, `src-tauri/gen/android/app/src/main/AndroidManifest.xml`: proposed `specialUse` foreground-service type and permission alongside existing `location` for outgoing shares. This is **subject to Google Play declaration and review**, not approved by virtue of the manifest.

### Validation performed locally

- Previous 2026-10-23 checks: TypeScript and 256 unit tests passed; ownership tests cover stale generations, encrypted state, stale observations, and strict native shutdown fencing.
- Revalidated 2026-11-04 using Node 24 after `corepack yarn install --immutable`: `corepack yarn typecheck`, `corepack yarn build:android:background-runtime`, and `corepack yarn test:scripts` (106/106) pass. Targeted sender-recovery and receiver-ownership tests pass (11/11). Supported Node 22 must still be validated in CI.
- Native Gradle/Kotlin, emulator E2E and physical Doze/overnight acceptance have **not run** in this sandbox; Java/ADB are unavailable. Passing TypeScript, script and bundling checks is not native evidence.
- `.github/workflows/android-standby.yml` now has a native compile gate and two manually dispatched Android emulator gates: independent browser→Android receiver and two-Android sender/receiver. The receiver CI job builds the browser sender before running it. These jobs have **not run**.
- The two-Android script requires a fresh received observation **and a new authenticated v3 receipt** after each peer's separate Doze exit. Both scenarios are syntax-checked but remain unexecuted on devices.

### Remaining release blockers

1. Verify the `native-build` GitHub Actions job compiles Kotlin/Rust into an installable APK, then trigger the manual browser→Android and two-Android standby gates. The latter covers independent sender and receiver recovery with fresh v3 acknowledgments. Repeat on Android 14/15/16 and physical devices.
2. Complete service/process recreation, permission withdrawal, notification action, network migration, and long Doze/overnight device tests. Add a two-device physical/OEM matrix and independently compare last GPS fix, submission, reception, and acknowledgement.
3. Verify displayed stale status and Android power-policy warnings, and review state-retention and the user experience of editing saved follows while the service owns them. Important known constraint: the receiver refuses ownership if the Activity's protected state still includes outgoing source or ended-share records. Implement safe field-level separation/merge before supporting concurrent roles on a single installation.
4. Submit the `specialUse` foreground-service case for Google Play review using `docs/ANDROID_SPECIAL_USE_PLAY_DECLARATION.md`, with real evidence videos. A Play Console submission/approval cannot be performed or assumed from this workspace. If rejected, redesign rather than adding unrelated permissions merely to satisfy a foreground-service type.

Both standby requirements remain release blockers until native/device evidence exists. No claims of guaranteed wakeups or always-live P2P while Doze restricts connectivity.

## Platform references

Android FGS types: https://developer.android.com/develop/background-work/services/fgs/service-types

Google Play declaration/review: https://support.google.com/googleplay/android-developer/answer/13392821

Android 12+ background start restrictions: https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start
