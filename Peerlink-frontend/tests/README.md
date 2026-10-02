# Transfer validation

## Run locally

From `edge/signaling-server`, run `node node_modules/wrangler/bin/wrangler.js dev --local --port 8787`.
From `Peerlink-frontend`, run `node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5173`.
The frontend signaling environment must point to `ws://localhost:8787`.

- `/transfer-test.html`: click **Run integration tests**. Uses two actual React hooks, WebSocket signaling, real reliable WebRTC channels, file-reader workers, SHA-256, and IndexedDB. Default large file: 128 MiB plus 123 bytes.
- `/transfer-test.html?quick`: same checks with an 8 MiB large file.
- `/transfer-test.html?membership`: checks the two-member room cap, third join rejection, exact-byte transfers, independent failure and recovery of both WebRTC endpoints, stale reconnect signaling rejection, persistent file retention, leave/rejoin, and roster status across idle/focus resync.
- `/transfer-test.html?group` and `/transfer-test.html?group-failure`: compatibility aliases for the two-member capacity and pair-recovery checks. Three-member group rooms are not supported.
- `node tests/membership-browser.cjs`: runs three independent Chrome processes against the local app. It verifies the visible 2/2 roster, durable full-room UI and saved-file access for the rejected third client, exact transfers, manual leave/rejoin, and session health. Set `PEERLINK_BASE_URL`, `PEERLINK_CHROME`, and `PLAYWRIGHT_MODULE` to configure the target/runtime. Set `PEERLINK_LONG_IDLE=1` to additionally suppress the second client's outbound heartbeat and sync frames for 190 seconds while its WebSocket stays open, then verify focus resync and a post-idle transfer; the full run exceeds four minutes.
- `/transfer-test.html?rooms`: checks persistent room reopen, preview and download bytes without a peer, deletion, temporary type synchronization, and cleanup on leave.
- `node tests/signaling-heartbeat.test.mjs` (from `Peerlink-frontend`): runs the actual signaling Worker with a fake clock and socket/storage shims. It checks two-member capacity, third join rejection, retention of open sockets across 240 seconds (including legacy/v2 clients), room snapshots, and reconnect routing.
- `/tests/faults.html`: click **Run fault tests**. Injects corrupt hashes, invalid sequence numbers, and a buffer-full send failure through simulated channels, using the real transfer engine and worker.
- `/tests/transport.html`: click **Compare packet sizes**. Measures raw local WebRTC without hashing, disk persistence, or application state.
- `/speed-benchmark.html?mib=64&bufferMiB=2`: click **Run full transfer benchmark**. Creates a local WebRTC loopback pair and runs the actual `TransferEngine`, including per-chunk SHA-256 checks and IndexedDB persistence. It verifies every persisted byte against deterministic source data and checks worker cleanup and send/receive buffer bounds. The file is 64 MiB plus 123 bytes; change `mib` and `bufferMiB` in the URL for controlled comparisons.

Integration checks compare every stored byte with deterministic source data; exercise 120 queued files (including an empty file), pause/resume, cancellation followed by another file, chat, simultaneous bidirectional transfers, bounded queue counters, worker cleanup, and unmount disposal. Tests delete only their synthetic files after successful checks. Failed/interrupted runs may leave their uniquely named test-room files in IndexedDB.

## Earlier baseline measurements

These measurements predate the larger batches and receive hash/storage pipeline below; they are historical baseline results, not a benchmark of that change.

Measured in the available in-app Chromium browser on this machine, using a local host-candidate connection:

- Full application: 128 MiB plus 123 bytes persisted and acknowledged in 177.39 seconds, **0.72 MiB/s**. Exact content verification passed.
- Raw transport: 16 KiB messages **0.81 MiB/s**; approximately 64 KiB messages **0.77 MiB/s**.
- Peak native sender buffer: 2,097,125 bytes, below the 2 MiB cap.
- Peak receiver uncommitted payload estimate: 1,504,384 bytes, below the 8 MiB credit limit.
- Workers and pending reads: zero after completion; both engines disposed on unmount.

These results do **not** demonstrate 16 MB/s or an improvement over the user's 1.25 MB/s measurement in a different environment. The raw comparison suggests this test environment has a transport constraint; it does not establish its cause. Benchmark the raw and full paths in the same browser, with the same peers and network, before attributing a speed limit to application code. Do not compare MiB/s with Mb/s: 16 MB/s requires at least 128 Mb/s of payload throughput.

## Large-file transfer trials (2026-10-02)

The 64 MiB runs used the benchmark above; the 32 MiB comparison used the same harness with `mib=32`. Every trial reported matching stored size, contiguous chunk indices, per-chunk SHA-256 verification, and an independent comparison of every persisted byte. Treat single-run throughput differences as illustrative; the 32 MiB comparison showed enough run-to-run variation to make small changes inconclusive.

- Pre-candidate-A reference at 64 MiB: 91.64 seconds, **0.70 MiB/s**.
- Candidate A at 64 MiB (1 MiB low-water threshold, 128 ms partial receive flush, and feature-detected IndexedDB commit): 82.37 seconds, **0.78 MiB/s**.
- Candidate A at 32 MiB: 56.01 seconds, **0.57 MiB/s**. Candidate C changed only the channel high-water mark from 2 to 4 MiB and took 54.93 seconds, **0.58 MiB/s** (about 1.9% faster, within observed variation); the 4 MiB setting was rejected.
- The 256 KiB packet fast path took 102.66 seconds, **0.62 MiB/s**, versus 82.37 seconds and 0.78 MiB/s for Candidate A at 64 MiB. Its integrity and lifecycle checks passed, but its throughput was lower, so the fast path and capability negotiation were rejected.

The retained implementation is Candidate A: approximately 64 KiB chunks, 2 MiB high-water, 1 MiB low-water, 128 ms partial receive flush, and explicit IndexedDB commit when supported. These measurements do not establish a general speedup or a 20% throughput gain.

## Implementation

- One active outbound file per peer, with a pipelined worker reader; both peers can send simultaneously.
- Approximately 64 KiB payloads, a 2 MiB DataChannel high-water mark, a 1 MiB low-water event threshold, and an 8 MiB sender-credit and receiver-uncommitted-data bound. The sender reads an initial 16-chunk batch (about 1 MiB), then batches of up to 32 chunks (about 2 MiB) with one batch prefetched; after startup, the current and prefetched packet batches hold up to about 4 MiB.
- Reliable ordered SCTP handles retransmission. Application acknowledgments report committed storage, not receipt into a JavaScript queue. No application retry timer resends chunks during pause/resume.
- Worker slicing, SHA-256, and transferable packet buffers; the receiver verifies hash/sequence/size, commits up to 32 chunks in one IndexedDB transaction, and hashes one following batch during that transaction. Incomplete receive batches coalesce for up to 128 ms. `saveChunks` feature-detects `IDBTransaction.commit()` after queueing all writes; browsers without it use the normal automatic commit, and acknowledgments still wait for transaction completion.
- Queue ownership outside React updater callbacks; completion requires receiver confirmation. Errors surface as failed transfers with explicit retry.
- Direct-to-disk saving where supported. Blob download fallback limited to 512 MiB and previews to 256 MiB to avoid unbounded reassembly. Large automatic downloads may require a manual Save action.

## Scope and limitations

Reload both peers: this is protocol version 3 and is not wire-compatible with older tabs. Manual pause/resume continues the same live transfer. Failed transfers are retried from the beginning with a new identifier; cross-reload partial-file recovery is not implemented by this engine.

Queue counters are not a heap profiler. These checks are not a guarantee against every memory leak, browser crash, or regression. Multi-device/WAN/TURN performance, low-memory devices, browser storage exhaustion, long-duration stress, and native save-dialog workflows still require separate validation. Native WebRTC sending remains on the main thread for compatibility; file reading and packet hashing run in a worker.
