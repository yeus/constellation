# v0.1.5-rc.2 device verification acceptance

## Field report and scope

During a real Android/browser pairing on November 25, Android showed the authenticated four-letter comparison while the browser did not. The paired browser and Android session exports established that the location-sharing link connected and a viewer was admitted, but neither export recorded the short-authentication-string exchange. The root cause of that particular occurrence cannot be proven retrospectively.

Investigation found two bugs: a follow-state object-identity assertion could reject valid comparison after a reconnect; and a receiver checked the sender-authenticated absolute expiry against its own device clock. The latter was **reproduced on two Android emulators using the new diagnostics**: sender code ready/presented, receiver completed proof verification and then recorded `failed.expired`. RC.2 uses stable capability URL/authenticated source binding and a separate conservative 120-second viewer deadline measured from its commit initiation. The sender's signed expiry remains in the MAC transcript and is enforced by the sender. No unbounded retries, protocol changes, or relaxed authentication; the existing three-attempt and two-minute limits remain.

## New diagnostics

UI session exports report `sharing.comparison.started`, `progress`, `ready`, `presented`, `failed`, `confirmed` and `cancelled`. Viewer progress includes `attempt-reserved`, `stream-open`, `challenge-received`, `proof-verified`, and `result-stored`. The failure entry carries the **last completed stage** plus a fixed cause such as `follow-changed`, `timeout`, `authentication`, `transport`, `expired`, or `attempt-limit`. Source result-ready entries distinguish Android service from foreground Activity; `presented` distinguishes sender approval, viewer preview, and optional verification dialog.

The Android persistent reliability journal also records only allowlisted short event suffixes (for example `ui.sharing.comparison.progress.challenge-received`); its existing strict native event/state validation is unchanged. Neither log records four-letter codes, challenges, links, capability secrets, peer IDs, or addresses. Diagnostic callbacks are explicitly unable to change a security decision.

## Automated evidence

- Node comparison and session-log tests: current follow-state object replacement, wrong link/source, denied/ended/cancelled run, MAC/replay/expiry/budget, allowed progress stages, redacted native event suffixes.
- Desktop and mobile-browser Playwright: each 6/6 comparison/onboarding tests passed, including matched codes and explicit approval.
- `yarn ci:quick` passed on the intermediate RC.2 changes; format, lint, tests, production build and unchanged RC.1 release metadata.
- Fresh x86_64 Android APK: initial comparison smoke exposed `failed.expired` at the viewer; a separate repeat aborted earlier with receiver `SIGABRT` during emulator startup. After the local-deadline correction, a clean rebuilt two-Android API 36 secure-comparison smoke **passed**, including authenticated receipt and no location access before approval. Script diagnostics now capture allowlisted comparison journal and presence of the code in UI on failures.
- The earlier RC.1 clean full preflight and 15/15 Android managed matrix apply only to that prior revision, **not yet** RC.2. New full acceptance remains to be run and recorded before tagging.

## Physical-device acceptance after RC.2

1. Android sender and browser viewer: create a **new single-recipient, approval-required** link. Open only after consent. Compare letters on both screens and approve only if identical. Repeat at least five times, including a reconnect while waiting for approval.
2. Reverse the direction: browser sender and Android viewer. Exercise optional verification on an already-connected link and check the full preview/dialog flow. Confirm no code leaks into exported logs.
3. Test a cancelled comparison and a manual retry; verify expired or mismatched attempts do not grant location. Do not exhaust the three-attempt cap on a link you want to keep.
4. If one device lacks letters, immediately export **both** session logs and the Android native reliability journal without resetting/recreating the link. Correlate `ready` and `presented` entries with the viewer's last `progress` stage and `failed` reason. Preserve the screenshots if possible without including any invitation QR or bearer URL.
5. Continue separate multi-night device reliability and battery tests required for 0.1.5 final.

RC.2 only becomes releasable after updated automated checks and version consistency pass. Signed Android publishing still requires GitHub release workflow secrets; the local sandbox does not hold signing keys.
