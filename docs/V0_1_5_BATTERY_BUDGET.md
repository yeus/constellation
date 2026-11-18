# Android background battery acceptance — v0.1.5

## Release gate

**Maximum: 2% shown for Constellation in Android's per-app Battery usage statistics during a predominantly background sharing/following workload.** This is the **Android app attribution percentage**, **not** 2% of full battery capacity, 2% of the device's total discharge, or an average target. Use a documented **24-hour unplugged reference period**, and record how the OS labels its denominator and the amount of foreground time separately. Do not claim compliance until the physical-device measurement is below or equal to 2%.

A full discharge and app attribution are independent quantities. Record battery level at the start and end as context, not as the pass/fail metric. Native Android battery data and OEM accounting can vary between devices; the target remains a release gate, not a guarantee from source-code inspection.

## Implemented acquisition behavior

- **No authorized viewers:** stop the continuous native watch; keep the P2P listener available, and request one fresh fix on authenticated subscription. Do not pretend that a connected viewer is actively inspecting the map.
- **Background / screen off:** request Battery Saver sampling (30 s / 25 m). Balanced requests 15 s / 15 m only when foreground-visible or during a permitted active-view boost. Android Battery Saver and Doze override viewing demand.
- **Location source:** prefer a single network provider for passive background updates. The **Network positioning only** device setting forbids GPS fallback for both periodic and one-shot native acquisitions. With Automatic selected, GPS is eligible for an exact-disclosure link when the source is foreground-visible or a permitted active-view lease exists. A missing provider is an unavailable fix, never a fabricated observation.
- **Disclosure precision is independent of the sensor.** A network fix can be accurate; only per-link exact/neighbourhood/city disclosure settings decide what recipients see. Viewing requests cannot change this.
- **Logging:** native watch and fresh-fix events aggregate into device-private, five-minute summary counts rather than synchronously appending a line for every fix.

## Authenticated active viewing

A recipient who explicitly focuses a single connected peer on the map or opens their details sends an optional `viewing` boolean in the existing authenticated v3 heartbeat, with an immediate transition signal and normal 10-second renewals. The same signal is delivered by the native receiver-owned background WebView when the foreground Android UI selects the peer. Older v2 peers remain compatible without boosting.

The sender accepts demand only from an **authenticated subscribed session**, with unpaused sharing and its own active-boost preference enabled. Leases expire after **25 seconds** without renewal. Unfocus, manual map panning, switching targets, hiding the app, stopping following, network disconnect, or process exit clears interest or lets the short lease lapse. No session or lease is persisted across process restarts.

**Source duty-cycle ceiling:** a rolling **60 seconds of higher-rate sampling in any 10-minute interval**, combined across all viewer requests. The native source accounts for time using a monotonic clock and schedules downgrade at lease or quota expiration, rather than relying on a future P2P heartbeat. High-rate mode is 15 s / 15 m; it does not override Network positioning only, Battery Saver, Doze, permission denial, paused sharing, or the sender's opt-out. A malicious authenticated viewer cannot request an unlimited boost.

## Mandatory validation before v0.1.5 release

Run two real Android phones, unplugged, with normal OS power restrictions. Record model, OS (including GrapheneOS when applicable), build identifier, APK checksum, app foreground/background time, Android's displayed Constellation battery percentage, Battery Saver/Doze state, start/end charge and exact measurement window. Never export coordinates or sharing bearer links.

1. Idle share with no viewers: no continuous location fixes; fresh first-viewer observation is still delivered.
2. One or multiple connected but **not actively viewing**: saver sampling, no continuous high-power GPS in background; authenticated delivery remains functional.
3. Foreground recipient focuses an approximate share: viewing signal travels through receiver ownership, 15-second source sampling is temporary, but disclosure remains approximate; pan away and app hide revoke demand.
4. Explicit exact share: GPS only when permitted, accurate uncertainty reported; Network positioning only still forbids GPS even during a boost.
5. Source pause, opt-out, Battery Saver, Doze, provider removal, reconnect, crash/restart, older v2 recipient and malicious repeated hints: verify expiry and the global rolling boost quota.
6. Receiver-only saved following and actual relay/cellular handoff: no loss of authorization, stale fixes never presented as live, sessions recover.
7. **24-hour background battery attribution:** at most **2% per the Android Battery usage app entry**, with no functional or security regressions. Compare before and after under similar conditions; if above 2%, profile background WebView/libp2p wakeups, CPU, network transport and GPS rather than silently suppressing authorized updates.

Automated protocol/controller/unit checks cover the implemented policy and bridge (309 JavaScript unit and 150 script tests passing). Native JVM regression tests for the rolling quota are added but **not yet executed**, and the updated Android/Kotlin code still needs a successful APK build. Physical performance and overnight reliability are **not yet verified**.
