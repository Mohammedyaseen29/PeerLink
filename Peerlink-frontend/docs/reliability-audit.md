# PeerLink reliability audit

This audit reviewed baseline commit `a52f903` on 17 November 2026, before implementation changes.

## Actual stack

React 19, TypeScript, Vite 7 and a service worker form the frontend. The deployed signaling service is a Cloudflare Worker using Hono and a Durable Object. It exchanges room membership, SDP and ICE over WSS. A room admits two people. Google STUN and the existing shared Open Relay UDP/TCP endpoints provide connectivity discovery and relay fallback. File contents travel through WebRTC. The receiver stores file chunks in its own browser's IndexedDB.

## Chrome versus Brave

The reported laptop failure happened before a data channel opened. One supplied Chrome trace showed an accepted remote answer followed by ICE checking. Another captured an offer in its first second. This places the observed failure in connection establishment. A packet-size diagnosis requires an open channel and a failed send.

In the user's comparison, two phones connected and laptop Brave connected to the phone, while laptop Chrome failed. A read-only Windows recheck on 17 November confirmed Wi-Fi on the Public profile with effective inbound Block and outbound Allow. Brave has two enabled Public inbound allow rules for its installed executable. The broad rules named `chrome.exe` point to Playwright Chromium under `ms-playwright/chromium-1223`. Installed Chrome at `C:\Program Files\Google\Chrome\Application\chrome.exe` has an enabled matching mDNS rule restricted to UDP 5353. The checked Chrome policy keys and Default profile preferences had no explicit WebRTC IP-handling override. These observations make executable-specific network policy a candidate cause. Confirming that cause requires a controlled Chrome-to-phone retest after checking the applicable network rules.

The historical Chrome-to-phone root cause remains unconfirmed. The current relay is retained at the user's request. The update adds bounded connection deadlines and exportable diagnostics so a recurrence has evidence about ICE, channel state, candidate types and relay errors. Same-machine automated checks and physical-device Wi-Fi checks have separate entries in the verification record.

## Confirmed code gaps

| Area | Baseline finding | Consequence |
| --- | --- | --- |
| Message size | Approximately 64 KiB payloads plus headers, with no negotiated SCTP limit check | A smaller negotiated limit can reject sends |
| Interrupted receive | Disconnect/dispose clears memory but leaves incomplete IndexedDB records | Hidden partial data consumes storage across retries |
| Retry identity | Queue retry reuses the original wire ID | Late messages can be confused with a new attempt |
| Pause/resume | Resuming an active engine resets displayed recipient bytes and progress | Incorrect progress and speed |
| Download fallback | Without `showSaveFilePicker`, downloads above 512 MiB are rejected | Firefox/Safari cannot save the accepted multi-GB workload through that path |
| Small-download fallback | All chunks become a Blob before download | Memory use scales with download size; requires a bounded alternative |
| Catalog sending | Snapshot messages are grouped by item count and sent synchronously | Long names/paths and large lists lack byte-based frame and queue bounds |
| Receive versus download | Opt-in automatic downloads can start after each received file | Browser multiple-download permission can block saves even when receipt succeeded |
| Initial timeout | Receiving remote SDP bypasses the original initial timeout | ICE can remain checking without a useful final state |
| Selection UX | Picking files immediately enqueues them | No review, selection summary, thumbnails, or pre-send removal |

## Existing protections to preserve

The baseline already has a per-peer sequential queue, reliable ordered data channels, file IDs and chunk indexes, receiver-ready and persisted-completion acknowledgements, SHA-256 validation before IndexedDB commit, native send-buffer backpressure, receiver commit credit, and bounded worker reads. Those mechanisms remain the basis of the transfer engine.

## Implementation direction

Use frames of at most 16 KiB, including the file header, and reduce the payload further when the negotiated SCTP limit requires it. Explicit versioned metadata records each file's chunk size. Fresh attempt identities, bounded local diagnostics, correct pause accounting, partial-data cleanup, and service-worker attachment streaming address the confirmed gaps. Stage files before sending and keep thumbnail creation and rendering bounded for large selections. Receiver integrity checks, local persistence, QR joining, and direct-first routing continue through the existing architecture. The WebRTC API defines the negotiated send limit, and RFC 8831 recommends small messages to avoid monopolizing an association when SCTP message interleaving is unavailable. [WebRTC specification](https://www.w3.org/TR/webrtc/#dom-rtcsctptransport-maxmessagesize), [RFC 8831](https://www.rfc-editor.org/rfc/rfc8831.html#section-6.6)

Browser storage quota, suspended/closed tabs, unsupported media codecs and network policy remain real constraints. Physical-device acceptance results must be recorded separately from synthetic, simulated-channel, same-host and compiler checks.

## Primary references

- [WebRTC specification](https://www.w3.org/TR/webrtc/)
- [RFC 8831](https://www.rfc-editor.org/rfc/rfc8831.html)
- [File System Access specification](https://wicg.github.io/file-system-access/)
- [WebRTC Stats specification](https://www.w3.org/TR/webrtc-stats/)
- [Service Workers specification](https://www.w3.org/TR/service-workers/)
