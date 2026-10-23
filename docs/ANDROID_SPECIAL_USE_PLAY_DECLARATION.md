# Android foreground-service declaration for Constellation v0.1.4

**Status:** Prepared for submission, not approved by Google Play. Review against actual device recordings, final manifests, and Play Console fields before submitting.

## Proposed foreground-service types

- `location`: User-initiated, opt-in outgoing location sharing. The phone obtains its own location while a background share is active.
- `specialUse`: User-initiated, opt-in **receiving** of encrypted P2P location updates from previously saved, authorized peers. The receiver does not request or sample the phone's own location. It must keep its listening transport active when the UI is hidden. There is an ongoing foreground notification with an independent **Stop background following** action. The opt-in is off by default.

Manifest subtype: `Explicitly enabled continuous encrypted P2P receiving from saved authorized peers, with a persistent notification and user-controlled stop`.

Do not select `connectedDevice` by adding irrelevant permissions or inventing companion-device pairing. Do not claim `specialUse` is guaranteed to be accepted: it is reviewed case by case.

## Suggested Play Console description: specialUse

**Functionality:** Constellation lets a person save an end-to-end encrypted P2P location share sent by another person and explicitly choose “Keep following in background”. With that switch enabled, the phone maintains an active receiving connection to those already-authorized saved shares without requiring the Constellation screen to stay open. It does not obtain the receiving phone's own location, enable reciprocal sharing, or record additional movement history. The user sees an ongoing foreground notification and can stop reception from that notification or from in-app Settings.

**Why uninterrupted operation matters:** The sender's location is used to view a voluntarily shared, time-sensitive position. Suspending the receiver delays updates, can leave a stale displayed location, and may require a new P2P negotiation. The app clearly marks stale or disconnected positions and recovers best-effort after connectivity returns; no delivery guarantee is claimed during Doze or connectivity restrictions.

**Why other foreground-service categories do not fit:** This is not a user-initiated bounded file download, media playback, navigation or sensing the local device's location. The P2P transport is for another human's authorized location share, not a paired Bluetooth/USB companion peripheral.

**User control and disclosure:** Switch is off by default. Only saved authorized peers qualify. Closing the Activity does not enable the service. A persistent notification states that Constellation is following saved peers and provides a Stop control. The user can also disable the switch in Settings. Notifications and Android system power restrictions are disclosed.

## Suggested Play Console description: location

**Functionality:** A person explicitly creates a time-limited, revocable location sharing link and chooses Android background sharing. Constellation shows a persistent foreground notification with pause/resume and allows link revocation in-app.

**Impact of interruption:** Recipients stop seeing fresh positions, and Constellation shows the last known position as delayed or stale. Automatic best-effort recovery is attempted when Android restores suitable network and power conditions.

## Required evidence video checklist

Record a real device or emulator with visible Android notifications. Show:

1. A sender sharing a location link and the receiver saving the incoming link.
2. Android receiver Settings, with “Keep following in background” initially unchecked; user explicitly enables it.
3. The ongoing “Constellation is following saved peers” notification with its independent Stop action.
4. App backgrounded / screen locked; location updates and honest stale status if paused by Android.
5. Open notification and stop background following; verify saved follow remains available when foreground resumes.
6. Outgoing location sharing separately: permissions, active notification, pause/resume and revocation.

Include a link to a hosted recording in the Play Console declaration; do not invent a video URL. Both foreground-service types require their own accurate description, interruption impact, and evidence video.

## Release verification

- Verify the merged Android manifest contains `FOREGROUND_SERVICE_SPECIAL_USE`, `location|specialUse`, and `android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE`.
- Build and test Android 14/15/16 with notifications disabled, location denied, screen lock, Doze, process/service recreation, and receiver-only use without local location permission.
- Ensure foreground-service startup is user-initiated and does not violate background-start restrictions on Android 12+.
- Run `yarn test:android:managed --receiver-standby-smoke` on a configured emulator. This scenario is a release gate, **not** a completed/observed test merely because its implementation exists.
- Google Play reviews `specialUse` use cases. If rejected, do not ship a noncompliant declaration; redesign and revalidate.

## Official policy references

- https://support.google.com/googleplay/android-developer/answer/13392821
- https://developer.android.com/develop/background-work/services/fgs/service-types
- https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start
