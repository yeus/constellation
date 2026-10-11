# Optional device comparison (v0.1.2)

## Design review and decision

The comparison belongs to Constellation recipient binding. The existing strict
`/constellation/location-share/2.0.0` stream remains unchanged by this feature.
`/constellation/device-comparison/1.0.0` carries only the comparison exchange;
Taskyon's existing FRP and libp2p transport primitives are reused without package
or generic protocol changes. Unsupported negotiation affects comparison only.

A truncated device fingerprint would permit offline key grinding and would not
identify a fresh admission session. Instead, the viewer commits to a fresh
256-bit random nonce before the sender chooses a fresh 256-bit challenge. The
sender obtains the viewer identity from the authenticated libp2p connection;
the viewer checks the authenticated connection owning the exact stream object
against the source identity in the invitation, failing closed on mismatch. The source
handler is scoped to its own share and source key. Both identities, their roles,
and the share ID occur in every cryptographic transcript.

This is an application-specific capability-authenticated design, not a claim to
implement a formally proved standard SAS protocol. The commitment-before-
knowledge principle is informed by [Vaudenay's SAS research](https://infoscience.epfl.ch/record/99433/files/Vau05a.pdf).
HMAC uses SHA-256 and the invitation's random capability secret, following the
keyed authentication construction in [RFC 2104](https://www.rfc-editor.org/rfc/rfc2104).
A separate expert cryptographic review remains desirable before relying on this
optional comparison for high-assurance identity decisions.

## Exchange

All hashes and MACs encode ordered JSON arrays of fixed-position fields. The
strings have separate versioned domain separators. No coordinates, secret,
nonces, codes or identities enter diagnostic logs.

1. Viewer creates nonce `Nv`; commitment `C` is SHA-256 of the commitment domain,
   share ID, source peer ID, viewer peer ID and `Nv`. The commit request includes
   share ID, `C`, and HMAC of the commit domain, identities and `C`.
2. Sender checks capability proof and eligibility: a pending manual request or
   the approved/first-claimed identity of a single-recipient link. It checks
   blocking, revocation, expiry and handler ownership. It reserves and durably
   saves an attempt before generating/sending challenge `Ns`. The response
   contains `Ns`, a two-minute deadline, and HMAC binding all identities, `C`,
   `Ns` and deadline.
3. Viewer verifies the response MAC and reveals `Nv` with an HMAC binding the
   entire transcript. Sender consumes its stream-local pending challenge before
   checking the reveal, rechecks admission eligibility, verifies `C` and HMAC,
   then displays the result and acknowledges with a distinct completion HMAC.
4. Viewer verifies that acknowledgement before displaying. Both derive the same
   letters using domain-separated HMAC over the full transcript and a sampling
   counter. A 32-bit sample is rejection-sampled into `26^4`; base-26 digits map
   to A-Z. This is a fresh interactive transcript, not an identity-hash prefix.

An honest viewer hides its nonce until the sender challenge is fixed. An honest
sender issues an unpredictable challenge after the commitment is fixed. Under
SHA-256 commitment binding/hiding and HMAC pseudorandomness assumptions, a
capability-holding interposer cannot choose identities or nonces adaptively to
force an honest comparison without consuming an online attempt. The exact
probability bound is a design argument under these assumptions, not a formal
proof or an independent audit.

## Limits and lifecycle

There are 456,976 possible strings: about 18.80 bits. An ideal independent
single-attempt false match has probability 1/456,976; three attempts have a union
bound of 3/456,976 (about 1 in 152,325). Human comparison errors, compromised
clients, ignored mismatches and an untrusted comparison channel invalidate this
bound. Copying device keys also defeats device distinction. Matching does not
identify a human, prevent onward disclosure, or repair a stolen capability.

Each side keeps a protected, persistent budget scoped to the share and its local
peer identity: three exchanges for the lifetime of that link. The sender's limit
is shared across all candidate viewer identities, preventing key rotation from
resetting it. Cancelled, expired and failed exchanges consume reserved attempts.
A failed persistence write releases no challenge; the in-memory reservation
stays consumed. At most 256 budgets are retained; a full budget store fails
closed. There is no time-based budget reset or automatic comparison retry.
Creating a new link creates a new budget and must not be used to retry a mismatch
until it agrees. A capability holder can deliberately exhaust a budget; this
availability tradeoff is preferable to unlimited 19-bit guessing.

A stream allows one commit and one reveal. Pending state is discarded on close,
cancellation or two-minute timeout. A replayed reveal has no pending challenge;
an old reveal cannot authenticate a fresh challenge. Replaying a commit can burn
an attempt but cannot restore the old code or old confirmation. Comparison does
not grant location access. Manual approval still gates location; first-device
claims persist before location and do not wait for comparison.

The viewer explicitly starts comparison. The two screens display large uppercase
letters in their normal text color. Only pressing **Letters match** persists a
local confirmation. It is bound to share, both exact device identities and the
fresh challenge; confirmation never implies that the other device confirmed.
A new exchange replaces the old local confirmation. Pending results expire in
two minutes; confirmations retain their historical transcript and are shown
only for the current eligible binding. Blocking, revocation, changed source or
local viewer identity, and stopping following invalidate their presentation.

**Cancel / mismatch** clears the local result and confirmation. Cancelling an
in-flight viewer exchange closes its stream. Cancellation after completion is
local: it does not remotely erase the other device's displayed result or its
independent confirmation. Tell the other person about a mismatch and reject or
stop the link. No automatic verified claim or remote confirmation message exists.

Comparison requires protected storage. It remains optional when storage is
unavailable or the peer lacks the new stream. Existing fingerprints retain their
existing informational role; they are not four-letter SAS values.

Clock skew can make comparison fail closed; the two-minute deadline is not a
trusted identity or wall-clock attestation.

## Implementation and validation

`src/sharing/deviceComparison.ts` owns schemas, transcript crypto, attempt
reservation and the responder state machine. `sharingRuntime.ts` owns transport
identity/eligibility, protected persistence and explicit confirmation. The same
runtime runs in the Android background WebView. Native commands forward only
explicit confirm/cancel actions; background status forwards validated results to
the UI. The Android service keeps its own protected identity and attempt budget.

Maintained unit/RPC regressions cover agreement, altered identity, altered
transcript/reveal, replay on the same and new streams, expiry, cancellation,
three-attempt persistence/failure, exact authenticated stream ownership and
separation from strict location messages. Runtime tests cover explicit
confirmation, persistence rollback, cancellation and changed/expired binding.
Browser integration tests in `tests/device-comparison.spec.ts` cover manual
approval and first-device claims over actual libp2p peers, no premature admission,
no automatic confirmation, explicit confirmation, cancellation and viewer
restart budgets. They are included in browser CI.

Sandbox limitations on 2026-10-08: local listening sockets are rejected with
`EPERM`, so the browser integration relay cannot start. The complete `yarn test`
command also stops in the vendor p2p runner's tsx IPC listener. The script
suite has four failing files involving sandbox-blocked child process execution
(`spawnSync git EPERM` in the preflight fixture and empty subprocess output in
APK-copy, log-download and release fixtures). No scripts were weakened. These are not
successful transport tests. Physical Android service restart, locked-screen
exchange, native command acknowledgement and browser-to-Android comparison
remain release acceptance. The sandbox has no `adb`; no Android SDK was installed
as a workaround. Real-network and human comparison acceptance remain unproved.

Completed sandbox checks: application unit suite (38 files), web build, Android
background JavaScript build, Android configuration check, Rust syntax parsing
and targeted formatting. Final lint is recorded after the final source audit.
No physical Android/native build or transport success is claimed.

To run the maintained browser integration outside this restricted sandbox:

```sh
corepack yarn exec playwright test \
  tests/device-comparison.spec.ts \
  --project=desktop --workers=1
```
