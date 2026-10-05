# `@taskyon/p2p-core`

Private libp2p infrastructure shared by browser Taskyon, Node diagnostics, and the relay service.

Browser callers that use private link-carried addresses can start with
`discovery: 'disabled'` to disable global discovery announcements and automatic
discovered-peer dialing. Set `relayAddrs: []` when the caller owns relay selection;
otherwise the startup relay list defaults to Taskyon's configured fallbacks.
Public discovery remains the default for existing Taskyon consumers. Browser nodes allow
30 seconds for both address dialing and inbound upgrades so relay-signalled SDP/ICE
negotiation is not cut off by libp2p's shorter TCP-oriented defaults. Unreachable
browser peers may consequently take longer to report a failure.

Supported package entry points include:

- `@taskyon/p2p-core/browser`
- `@taskyon/p2p-core/node`
- `@taskyon/p2p-core/relay`
- `@taskyon/p2p-core/discovery`
- `@taskyon/p2p-core/constants`

The package provides transport setup, relay connections, topic routing, subnetwork discovery
tokens, and test-network helpers. The protocol remains experimental.

```bash
yarn workspace @taskyon/p2p-core build
yarn tycli:diagnostics --filter discovery --details
```
