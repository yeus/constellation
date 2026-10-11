# Very-short share URL architecture review (v0.1.2)

## Decision

**Keep the existing self-contained, fragment-only compact URL as the default. Do not deploy a bare-token URL shortener.** A shortener whose token alone can reconstruct the entire bearer capability transfers access control to the resolver and creates a central point of location-access compromise. This contradicts Constellation's P2P and local-first privacy claims.

A future optional **encrypted alias** can shrink long transport-heavy URLs, but its client-held decryption key must remain in the URL fragment; it cannot honestly be an ultra-short code. The 0.1.2 scope is the design review, **not** shipping a resolver or changing the invitation format.

## Designs

| Design                             | Typical result                                                                                          | Who can recover location capability?                                                                  | Dependencies                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Existing compact `#share=...`      | Longer QR/string; already implemented                                                                   | Only recipients of link; no alias lookup                                                              | Hosted page for first launch; P2P/relays afterward           |
| Plain alias `/s/<token>`           | Shortest                                                                                                | Anyone with token **and resolver operator** (or compromised DB); operator can mint/replay bearer URLs | Resolver availability, durability, metadata logs, anti-abuse |
| Encrypted alias `/s/<id>#k=<key>`  | Shorter than full URL when metadata is large, but contains at least ~43 base64url chars for 256-bit key | Anyone with complete URL; resolver stores opaque encrypted capability, not decryption key             | Same resolver dependency; key storage stays on client        |
| Offline verbal transfer / mnemonic | Requires independent rendezvous or manual data transfer                                                 | Depends on design; unacceptable if the capability secret is truncated                                 | Additional trusted channel / handshake                       |

## Security and privacy constraints

1. All authorization-bearing fields remain encrypted and authenticated **client-side** before upload for encrypted aliases. The resolver never receives the fragment key in normal HTTP requests, referrals, or application telemetry. It should only return ciphertext, version, expiry and integrity metadata; the browser decrypts after loading.
2. Use an independent randomly generated 256-bit AEAD key in the fragment and an unguessable random alias ID. No capability, peer IDs, addresses, fingerprint or coordinates in the request path. Use versioned AES-GCM associated data binding the alias, format version and expiry. Enforce strict ciphertext size, compression-expansion and schema bounds. Never evaluate returned HTML/scripts; resolver responds as immutable data with correct content type and no-store headers.
3. Lookup metadata **still reveals** alias ID, requester IP, time, user agent and probable geographic/network information. DNS/CDN/hosting providers may see traffic. A resolver can deny, replay stale ciphertext or correlate requests. It cannot promise no logging. A compromised resolver could link requests and replace ciphertext, although AEAD detects unauthorized changes.
4. Upload and lookup are server-dependent. **Never make sharing depend on a successful alias lookup.** Resolver failures, captive portals, blocked DNS, censorship, expiry and deletion must produce a clear failure, not auto-fallback to a different unverified capability.
5. Generate and retain a **fully self-contained compact fallback URL** at creation time. Expose “Use self-contained link” and “Copy fallback link” before sending, not a redirect from failed lookup (which is impossible without a full capability already present). Local-first/offline-only users can always choose self-contained sharing.
6. Preserve the existing owner identity proof, share secret, expiry, addresses and capability version exactly after decrypt. Existing JSON and compact fragment readers continue to work. Alias resolution is additive and strictly versioned.
7. Alias deletion can remove resolver mappings, but **does not revoke an already-resolved capability**; sender-side share revocation remains authoritative. Alias expiry must never exceed original share expiry. Guarantee bounded retention, explicit deletion, and avoid extending mappings merely because an alias was read.
8. Block untrusted redirects (open redirects, URL schemes, arbitrary script origins), enforce per-IP and per-alias rate limits and abuse controls, and never interpret a resolver response as permission to bypass recipient admission/verification. Avoid analytics and advertising SDKs.

## Proposed future API / lifecycle

- After making the canonical share, client offers “Compact link (recommended)” versus “Shorter online link (requires lookup)”, with a metadata and availability notice.
- If opted in, generate alias ID and encryption key locally; encrypt canonical compact capability; upload ciphertext with max TTL; receive only confirmed alias ID; create `https://<resolver>/s/<id>#k=<key>`. Keep original canonical link available.
- On opening alias, enforce HTTPS, fetch immutable opaque ciphertext, validate bounded envelope/AEAD against key and alias, parse original capability through existing strict decoder, then use the same private P2P authentication and admission flow.
- If lookup fails or key/authentication fails, display a specific error and request the sender's self-contained fallback link. **Never** silently drop into an unauthenticated viewer flow.
- For migration retain both readers; preexisting compact/legacy links are not rewritten. Deleting alias must not delete sender's share state.

## Acceptance and outstanding decision

The security recommendation is to **defer resolver implementation** until there is a credible use case requiring it (for example QR scan constraints or manual transcription), with a measured before/after size distribution. An encrypted alias adds hosting/abuse/deletion work and links still need a 256-bit fragment key, so the UX benefit may be small. A plain token alias should be rejected.

Before shipping any resolver: threat-model review by a second reviewer; encrypted fixture and corruption tests; fragment-leak tests; offline/self-contained fallback; migration roundtrips; no open redirect; TTL and revocation checks; hosting outage simulation; Android external-link intake tests; observable resource/cost budgets; privacy-policy disclosure for resolver access logs.

**No resolver code, endpoint, settings option, telemetry or additional service has been introduced in v0.1.2.**
