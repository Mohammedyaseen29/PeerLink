# Device connection failures

Joining a room uses the Cloudflare signaling WebSocket. File transfer, chat and
previews use a separate WebRTC connection. Both devices can appear in a room even
when ICE cannot find a usable path. Being on the same Wi-Fi does not guarantee
that the access point, operating system and browsers allow that direct path.

## November 23 investigation

The previous build used one Google STUN service and the old shared
`openrelay.metered.ca` TURN credentials. Repeated live probes from the development
machine succeeded against Google STUN, but timed out against the old relay on UDP
80/443 and TCP/TLS 443. This demonstrates an unavailable fallback from that
network; it does not establish which local-network restriction affected the
reported laptop/phone pair. Their complete connection diagnostics are still
needed to distinguish ICE, mDNS, policy and SDP failures on those devices.

The default now uses Google and Cloudflare STUN. Account-specific TURN settings
arrive in the Worker `joined` response before a peer connection is created.
`ICE_SERVERS` is a Worker secret containing a JSON array of browser ICE servers.
A valid `VITE_ICE_SERVERS` build override remains supported. Invalid server
configuration falls back to STUN and records a configuration error, rather than
crashing the room join. The removed shared public relay is not treated as a
working backup. The Worker does not relay file contents.

Failed sessions retain connection states and candidate-type counts after their
RTCPeerConnection is disposed. Candidate-add and SDP error names are recorded
without addresses, SDP, files or credentials. The failure message distinguishes
an unanswered offer, missing relay configuration and failure to obtain a relay
candidate. ICE completion markers are forwarded so the other browser knows when
gathering has finished. Existing room membership and saved files are preserved.

## Configure a free relay

[ExpressTURN](https://www.expressturn.com/) currently advertises a free account
with 1,000 GB/month and UDP/TCP on port 3478. Account signup and the provider's
bandwidth limits still apply. No public no-account relay is assumed reliable.
The rstream no-account generator is expressly limited to temporary evaluation
and one-hour credentials, so it is not a production fallback for long transfers.

1. Create a free provider account and copy its endpoint, username and password.
2. Create `edge/signaling-server/.turn-credentials.local.json` with:

   ```json
   { "endpoint": "YOUR_SERVER:3478", "username": "YOUR_USERNAME", "credential": "YOUR_PASSWORD" }
   ```

3. From `edge/signaling-server`, run `node scripts/configure-turn.mjs`.
   It checks real authenticated TURN allocations, releases the test allocations,
   and deploys the working UDP/TCP URLs via Wrangler's `ICE_SERVERS` secret.
   Failed allocations prevent a credential update. Credentials are piped through
   stdin, never printed or passed as command-line arguments. The local file is
   excluded from Git. Existing Cloudflare authorization must still be valid.
4. Rejoin on both devices. Check Connection details for `relayConfigured: true`
   and local/remote relay candidates. A configured relay is not proof that the
   selected connection uses it; check `selectedCandidatePair` as well.

These are browser-usable TURN credentials, which WebRTC clients must receive;
they are not private provider management API keys. Do not put provider API keys
in this file or in `VITE_ICE_SERVERS`. For a provider supporting short-lived
credentials, issue them on the Worker instead of shipping a management key.
Custom UDP/TCP/TLS arrays can be configured directly with
`npx wrangler secret put ICE_SERVERS`; use only transports supported by the plan.

## Validation

`node --test --test-reporter=spec tests/*.test.mjs` covers config validation,
the actual Worker room handshake, ICE completion forwarding, failure guidance,
room retention and signaling recovery, along with the existing transfer tests.
`node scripts/probe-ice.mjs` in the Worker directory checks the old service and
the two current STUN services without recording client addresses.

The supplied free ExpressTURN account accepted authenticated UDP and TCP TURN
allocations and is configured on the deployed Worker. A real Chromium browser
test using two application hook instances and production signaling forced
`iceTransportPolicy: 'relay'` on both peers. Both selected relay candidates over
UDP. An 8 MiB + 123-byte file was received and verified byte for byte; chat was
delivered. A deliberate signaling outage during the transfer preserved the
original RTC links and peer identities. Sender buffering peaked at 261,993 bytes
and receiver buffering at 243,840 bytes. Test files and room membership were
removed afterward.

The free relay was slow on this route: 180.60 seconds for that transfer, about
0.04 MiB/s. This validates connectivity and bounded memory, not large-file speed.
Direct local connections remain preferred. The actual Chrome/Edge laptop-to-phone
pair still needs a user retest; the specific restriction on its direct Wi-Fi path
was not established from the brief status report.

## A phone hosting its own peer's hotspot

The user confirmed that the participating phone also provides the laptop's
hotspot. This differs from two devices being clients of a separate Wi-Fi router.
Android documents the hotspot interface as a local network separate from the
networks used to obtain internet access, with explicit discovery requirements for
some applications. See [NET_CAPABILITY_LOCAL_NETWORK](https://developer.android.com/reference/android/net/NetworkCapabilities#NET_CAPABILITY_LOCAL_NETWORK).
This makes missing/unreachable hotspot ICE candidates a plausible cause. It is
not a confirmed device-level diagnosis without that phone's ICE report. A web
page cannot choose a hidden Android tethering interface or change its OS routing.

The initial firewall audit found rules named `chrome.exe` that allow inbound
UDP/TCP on Public networks. A subsequent executable-path comparison showed those
rules do not match the Chrome executable actually running on this laptop. For
that executable, the matching inbound rule allows mDNS discovery on UDP 5353
only. The effective Public profile blocks unmatched inbound traffic and allows
outbound traffic. This is another possible restriction on a direct path, not
proof that it caused this ICE failure: replies associated with outbound traffic
can still be allowed. Device ICE reports and a controlled retest are needed
before proposing a firewall exception. No firewall, browser privacy or hotspot
security settings were changed.

Two app reporting issues were also corrected: local sessions were collapsed
into the generic P2P label, and the selected ICE route was sampled only once at
channel open. The route now follows selected-pair changes, with a bounded
three-second stats poll for browsers that do not deliver the event. A stats
error leaves the working transport intact; disposal removes its timer/listeners.
Unknown or public host addresses use the conservative P2P label instead of
claiming a local network. The app explicitly uses ICE policy `all`; only the test
fixture's optional relay mode forces `relay`.

Connection details are available while connected and shown as a copyable report.
They include the actual ICE policy, observed route, separate local/remote
candidate counts and up to 64 candidate-pair check summaries. No IP addresses,
ICE URLs, SDP or credentials are included in these summaries. Unanswered direct
checks and missing direct candidates can then be distinguished from a stale UI
badge. Connect both peers as clients of a separate router or a third phone's
hotspot for a useful comparison with the host-phone scenario; direct connection
still depends on that network allowing it.

Validation of the reporting fix: 51 frontend regression tests and the production
build passed. Two real app tabs joined a temporary room through production
signaling with TURN configured. Their connected-state UI exposed the report;
it showed ICE policy `all`, the active host/host UDP pair and a matching P2P
badge. Candidate-pair request/response counts were visible without addresses.
Unit tests cover selected-pair precedence, local aggregation, public/hidden
address handling, relay-to-direct changes, stale async reads and monitor cleanup.
