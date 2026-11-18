# PeerLink verification results

Tests ran on Windows using disposable browser contexts, unique room IDs and synthetic payloads. Automated connection tests used the Cloudflare Worker source running locally through Wrangler. The transfer engine used its application worker, integrity checks and IndexedDB persistence.

| Check | Outcome |
| --- | --- |
| Production build | Passed TypeScript, Vite and PWA service-worker generation. |
| Chrome batch | Passed with 500 synthetic binary files over real WebRTC. The receiver verified exact bytes, unique file IDs, duplicate and Unicode names, empty files and chunk boundaries. Two application hooks ran in one Chrome page. |
| Chrome media batch | Passed a single queue of 250 generated PNG entries and 250 valid MP4 entries, totaling 65,787,000 bytes. The receiver verified unique IDs, MIME types, sizes, exact stored bytes and SHA-256 hashes for all 500 files. |
| Native frame size | All 640 observed data frames fit within 16 KiB. The browser reported a negotiated limit of 262,144 bytes. |
| Smaller negotiated limit | Passed a separate 49,175-byte engine test. The largest frame was 4,096 bytes, including headers, with a negotiated chunk size of 4,041 bytes. The receiver verified the stored payload. |
| Chrome transfer controls | Passed same-attempt pause and resume, cancel and advance, fresh-ID retry after an injected read failure, bidirectional transfer, chat and cleanup. |
| Chrome ↔ Brave | Passed in independently launched, installed browsers on the same Windows host. The receiver in each browser verified all 4,194,427 bytes. Both reported P2P. |
| Firefox 153.0 and Edge 157.0.4341.60 | Both passed the 500-file real WebRTC suite with exact byte comparison, frame limits, pause, cancel, retry, bidirectional transfer and cleanup. Edge also passed the 500-file PNG/MP4 batch. |
| Playwright WebKit 26.5 on Windows | The runtime did not expose `RTCPeerConnection`, which blocked a WebRTC run. Safari on macOS and iOS remains to be tested. |
| Persistent and temporary rooms | Passed reopening persistent files without the sender, exact local preview and download checks, deletion of file and chunks, and temporary-file cleanup on leave. |
| Remote preview worker | Passed recovery after forced loss of worker control, then read an exact 400-byte range with HTTP 206. Chrome reported no page errors. |
| Streamed browser download | Chrome downloaded and saved 34,603,131 bytes through the service worker. The response included attachment headers and exact content length. A streamed SHA-256 comparison matched the expected payload, and reusing the URL returned HTTP 410. |
| Room capacity and recovery | Passed third-join rejection at two peers, idle heartbeat and focus sync, RTC recovery at each endpoint, stale signaling rejection, and a slot reopening after leave. The receiver verified payload bytes after reconnecting. |
| Integrity and backpressure faults | Passed corrupted-chunk, invalid-sequence, synthetic buffer-full pause and retry, and legacy v3 compatibility checks. |
| Large file | Passed transfer, persistence and exact byte verification of 2,147,483,771 bytes. Chrome read the disk-backed source through the application worker and checked stored bytes in ranges of at most 1 MiB. This test used simulated data channels to exercise the engine and storage at full size. |
| Selection and queue UI | Passed 29 checks, including 500 staged items, directory reads beyond 100 entries, paging, queue actions, errors, 44 px touch targets and no horizontal overflow at 320 px. |

The first attempt to generate the large test file hit an OPFS quota in a private browser context at about 1 GiB. The completed run used a dedicated persistent profile and Chrome's normal quota settings.

## Physical-device acceptance

The original Windows Chrome-to-phone incident still needs a test using the affected laptop, phone and Wi-Fi. Review the traces and read-only firewall comparison in the audit. The checklist covers device pairs, real-world media batches, large-file downloads, OS save dialogs and storage behavior. [Reliability audit](./reliability-audit.md) · [Manual checklist](./manual-transfer-checklist.md)
