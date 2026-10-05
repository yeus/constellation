# Constellation 0.1 acceptance

The five field fixes, QR scanning, uniform own/followed markers and executable sharing diagnostics
are required for 0.1. General Groups and delegation remain 0.2. This checklist records release
acceptance separately from implementation and regression coverage in SYSTEM_DEFINITION.csv.

## Automated repository checks

Run unit/vendor/script tests, Android configuration checks, type checks, web and Tauri frontend
builds, and browser regressions. The CI browser-regression job includes the executable sharing
suite. The suite is also available in production: Menu → Diagnostics → Run sharing diagnostics.

Select a category and run one check, the category, or all diagnostics. Default all-runs execute
local/network checks and skip paired or guided checks without their prerequisites. Skips are never
passes. Copy Results exports controlled outcomes and transport types, not location/network secrets.
Temporary synthetic sessions use memory-only private state. Closing the suite cancels the run and
waits for session cleanup. Test links expire even if a participant closes its app unexpectedly.

## Two-device network acceptance

1. Install/open the intended release on two devices. Use different networks for at least one run,
   such as Wi-Fi on one device and mobile data on the other.
2. On both devices open the suite and select Paired sharing. On device A choose Start a test pair,
   then run Two-way sharing and revocation.
3. On device B choose Join a test pair. Copy or scan A's temporary diagnostic link, then run the
   same named check. Both screens must report a pass. Save only the redacted result reports.
4. Repeat Link expiry with a fresh link. It expires after one minute; join promptly.
5. Repeat Network reconnect with another fresh link. Disconnect B's network until disconnected
   presence is observed, then restore it. Both devices must finish successfully.
6. Repeat on representative networks. Record only network categories (for example Wi-Fi/mobile),
   app build, outcome and transport classification; omit names, addresses and device identifiers.

These checks exchange synthetic coordinates through production sharing operations. They verify
actual transport paths but do not prove physical GPS accuracy, battery endurance or every NAT.
Every paired case needs a new invitation and both participants must choose the same case.
Guided category/all runs pause on the joining device for each fresh link; paste or scan it there. The
three-minute case budget includes pairing. A failed run does not publish its raw exception text.

## Basic Android 0.1 acceptance

Known limitation accepted for 0.1: the Android 10 AOSP/no-GMS emulator with stock
WebView 74 intermittently aborts in Chromium's native GPU thread during sharing.
Android 10 Play and Android 16 emulator tests passed; physical-device and other
Android-version compatibility remain unverified. See the [Android emulator
results](DEVELOPMENT.md#android) for symptoms, coverage and investigation limits.
Record this known failure when it occurs; the physical-phone checks below remain
required.

- Build using the intended production signing identity, verify the release signature/checksum,
  install on a physical supported phone, and verify upgrade without destroying saved links.
  Keep signing secrets outside reports and source control.
- Verify foreground location permission, denied permission, coarse-only permission, background
  permission guidance, notification permission, and the Android system share sheet.
- Scan a QR displayed on a second device. Verify camera permission, denied-camera fallback,
  decoding, validation and the normal explicit native approval path.
- Verify ACTION_VIEW, two successive ACTION_SEND links, and hosted App Links. Confirm current
  hosting/certificate/asset-links behavior rather than assuming the older recorded failure persists.
- Run foreground-only sharing and background sharing; repeated create taps must create one link.
  Verify connected-device block survives service recreation and preserves other viewers.
- For a guided background diagnostic choose Android background on both participants. Android A
  chooses Start a test pair and explicitly permits real location. B chooses Join and uses the new
  link. Lock/unlock A and move a short distance where safe to allow a fresh fix. The run checks
  native sharing continuity and received updates, then revokes only its own test link. A missing
  timestamped fix from the locked interval is reported as skipped, never a pass; a fix acquired
  immediately after unlock can replace that evidence, so a skip does not prove background failure. The native
  link is a normal finite one-hour service link and is stopped on normal completion/cancellation.
  If the app is force-stopped during this optional check, stop that test share after reopening.
- Check actual UI layout, SVG alignment/touch targets, status placement, map marker color and zoom
  transitions, theme repaint, labels, attribution safe areas and launcher/notification icons.

The longer representative-vendor endurance matrix (prolonged battery behavior, reboot/process
loss, long expiry and radio handoffs) remains the separate 1.0 maturity gate.

## Linux and release acceptance

On a normal desktop session with an unlocked Secret Service, launch both packaged AppImage and
Flatpak. Verify map loading, live sharing, QR capture where supported, saved-follow/share recovery,
and behavior with a locked keyring. Rebuild and lint Flatpak on a Flatpak-capable host; the sandbox's
bubblewrap restriction is not build evidence. The final Flathub submission manifest must be authored
and reviewed by the maintainer according to the recorded submission policy.

Complete one two-person cross-client use of the actual packaged clients and hosted browser,
including return sharing, several viewers, freshness, independent link revocation and reload.
Run a reviewed tagged release build to confirm signed Android, AppImage, Flatpak, screenshots and
checksums are produced. Review full bundled license texts/notices and applicable distribution
conditions for every final artifact before publication. This implementation does not create a tag
or publish a release.

## Read-only host readiness report

From the Constellation checkout on the host:

```sh
node scripts/release-acceptance.mjs
```

This writes a private, timestamped `release-acceptance-*.json` report of tool availability and known
artifact presence. It does not enumerate devices, read keys, sign, install, launch packages or
change host settings. Return the report for inspection; it establishes readiness only, not passed
runtime acceptance. Keep real-network reports private until reviewed.
