# Android background battery acceptance — v0.1.5

## Release gate

**Maximum: 2% shown for Constellation in Android's per-app Battery usage statistics during a predominantly background sharing/following workload.** This is the **Android app attribution percentage**, **not** 2% of full battery capacity, 2% of the device's total discharge, or an average target. Use a documented **24-hour unplugged reference period**, and record how the OS labels its denominator and the amount of foreground time separately. Do not claim compliance until the physical-device measurement is below or equal to 2%.

A full discharge and app attribution are independent quantities. Record battery level at the start and end as context, not as the pass/fail metric. Native Android battery data and OEM accounting can vary between devices; the target remains a release gate, not a guarantee from source-code inspection.

## Implemented acquisition behavior

- **No authorized viewers:** stop the continuous native watch; keep the P2P listener available, and request one fresh fix on authenticated subscription. Do not pretend that a connected viewer is actively inspecting the map.
- **Background / screen off:** request network positioning at a configurable 1, 5, or 10-minute interval (default **5 min**), plus passive-location events for significant movement (at least 50 m, subject to reported accuracy). A passive listener does not cause GPS to run. Request 15 s / 15 m only during foreground use or a permitted active-viewing boost. Android may delay callbacks; Battery Saver and Doze override viewing demand.
- **Location source:** prefer the network provider while hidden, including during permitted active viewing; never select GPS merely because a background share is exact. If the network provider is **unavailable**, the **Automatic** provider setting permits GPS as a fallback to avoid silently breaking authorized sharing. **Network positioning only** strictly forbids GPS fallback, in both foreground and background; without an available network provider, location may be unavailable. A missing fix is never a fabricated observation.
- **Disclosure precision is independent of the sensor.** A network fix can be accurate; only per-link exact/neighbourhood/city disclosure settings decide what recipients see. Viewing requests cannot change this.
- **Logging:** native watch and fresh-fix events aggregate into device-private, five-minute summary counts rather than synchronously appending a line for every fix.

## Authenticated active viewing

A recipient who explicitly focuses a single connected peer on the map or opens their details sends an optional `viewing` boolean in the existing authenticated v3 heartbeat, with an immediate transition signal and normal 10-second renewals. The same signal is delivered by the native receiver-owned background WebView when the foreground Android UI selects the peer. Older v2 peers remain compatible without boosting.

The sender accepts demand only from an **authenticated subscribed session**, with unpaused sharing and its own active-boost preference enabled. Leases expire after **25 seconds** without renewal. Unfocus, manual map panning, switching targets, hiding the app, stopping following, network disconnect, or process exit clears interest or lets the short lease lapse. No session or lease is persisted across process restarts.

**Source duty-cycle ceiling:** at most **10 minutes of higher-rate sampling in any rolling 20-minute interval**, combined across all viewer requests. The native source accounts for time using a monotonic clock and schedules downgrade at lease or quota expiration, rather than relying on a future P2P heartbeat. High-rate mode is 15 s / 15 m; it does not override Network positioning only, Battery Saver, Doze, permission denial, paused sharing, or the sender's opt-out. A malicious authenticated viewer cannot request an unlimited boost.

## Mandatory validation before v0.1.5 release

Run two real Android phones, unplugged, with normal OS power restrictions. Record model, OS (including GrapheneOS when applicable), build identifier, APK checksum, app foreground/background time, Android's displayed Constellation battery percentage, Battery Saver/Doze state, start/end charge and exact measurement window. Never export coordinates or sharing bearer links.

1. Idle share with no viewers: no continuous location fixes; fresh first-viewer observation is still delivered.
2. One or multiple connected but **not actively viewing**: saver sampling, no continuous high-power GPS in background; authenticated delivery remains functional.
3. Foreground recipient focuses an approximate share: viewing signal travels through receiver ownership, 15-second source sampling is temporary, but disclosure remains approximate; pan away and app hide revoke demand.
4. Explicit exact share: GPS only when permitted, accurate uncertainty reported; Network positioning only still forbids GPS even during a boost.
5. Source pause, opt-out, Battery Saver, Doze, provider removal, reconnect, crash/restart, older v2 recipient and malicious repeated hints: verify expiry and the global rolling boost quota.
6. Receiver-only saved following and actual relay/cellular handoff: no loss of authorization, stale fixes never presented as live, sessions recover.
7. **24-hour background battery attribution:** at most **2% per the Android Battery usage app entry**, with no functional or security regressions. Compare before and after under similar conditions; if above 2%, profile background WebView/libp2p wakeups, CPU, network transport and GPS rather than silently suppressing authorized updates.

Automated protocol/controller/unit checks cover the implemented policy and bridge. The x86_64 Android debug APK and native Kotlin/JUnit quota tests **passed** on November 17, 2026; focused script and browser coverage also passed, with intermittent P2P setup/timing failures documented in `V0_1_5_RC_1_GATE.md`. This is not proof of the 2% battery ceiling. Physical 24-hour measurement, overnight delivery and RC upgrade acceptance are **not yet verified**.
