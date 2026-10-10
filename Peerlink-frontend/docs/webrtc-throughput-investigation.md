# WebRTC transfer throughput investigation

Date: 10 October 2026.

## Verified file-engine measurements

These measurements use the existing transfer engine, SHA-256 validation, IndexedDB transactions, and completion acknowledgements. Each test transferred 32 MiB plus 123 bytes and independently compared every persisted byte with the source.

| Endpoint setup | Elapsed time | Receiver-verified mean |
| --- | ---: | ---: |
| Two peer connections in one Chrome process | 42.84 s | 0.75 MiB/s |
| Two independently launched Chrome processes | 24.34 s | 1.31 MiB/s |

This is a comparison of benchmark topology, not a speed increase caused by a code change. Separate browser processes better represent separate browser applications or devices, although both processes still ran on one Windows machine. Neither result predicts throughput between two physical devices.

The separate-process test recorded:

- Sender channel wait: 23.64 seconds; receiver credit wait: zero.
- Residual sender file-read wait: 80 milliseconds.
- Receiver SHA-256 work: 76.6 milliseconds; storage transactions: 327.9 milliseconds.
- Low-buffer events: 247; channel timeout fallbacks: 4; no low-event wake found an empty buffer.
- Native send rejections (`OperationError`): zero.
- Peak sender buffered data: 261,936 bytes; peak uncommitted receive data: 261,632 bytes.
- All 514 stored chunks and all 33,554,555 bytes verified.

Hashing and storage account for little of the elapsed time in this test. The sender spends most of its time waiting for the data channel. That measurement alone does not identify SCTP congestion, packet loss, operating-system queueing, or a browser implementation problem.

## Verified raw transport measurement

A fresh pair of independently launched Chrome 154 processes transferred binary data directly, bypassing file reads, SHA-256 work, storage, and the file engine. The pages were visible `about:blank` pages. The channel was reliable and ordered, with 64 KiB frames, a strictly enforced 256 KiB high-water cap, and a 128 KiB low threshold.

Each run used a unique ID. START, READY, END, and ACK messages used the same ordered channel as the payload, so an ACK from a previous run could not count as completion. Receiver byte totals and the queue cap were asserted.

| Run | Received bytes | Elapsed time | Mean |
| --- | ---: | ---: | ---: |
| Warm-up | 8,388,608 | 4.93 s | 1.62 MiB/s |
| Measured | 16,777,216 | 9.96 s | 1.61 MiB/s |

Peak buffered data was exactly 262,144 bytes. Receiver interval rates ranged from 1.43 to 1.76 MiB/s. The transport-selected ICE candidate pair used host candidates and UDP. ICE/STUN RTT was 26 ms before transfer and 178 ms under load; socket send-discard counters were zero. RTP available-outgoing-bitrate was unavailable.

A repeat using the saved portable harness measured 1.47 MiB/s and again verified every receiver byte and the buffer cap. The difference between 1.47 and 1.61 illustrates run-to-run variation.

The raw result is not a matched estimate of pipeline overhead: the raw run had an explicit warm-up, the file-engine run was larger and started cold, and measurements ran at different times. The useful conclusion is that even raw WebRTC stayed far below 20 MiB/s in this environment. This is not a universal WebRTC speed limit. The RTT increase suggests queueing or processing delay under load, without identifying its location.

Earlier raw runs and browser/threshold comparisons had completion-ACK or queue-cap flaws. Their numbers are discarded. They are not evidence for a speed improvement or a browser recommendation.

## Architecture findings

1. **More data channels do not create independent congestion windows.** SCTP applies congestion control to an association, which carries the data, control, and preview channels. Adding channels to the existing peer connection cannot multiply its available bandwidth. [RFC 8831](https://www.rfc-editor.org/rfc/rfc8831.html).

2. **Browser buffer counters are not delivery counters.** `bufferedAmount` describes queued application bytes and excludes protocol framing and operating-system buffers. Chrome also coalesces native-to-renderer buffer updates. Its current native source waits for a decrease greater than 100 KiB, or a drain to zero, before updating the cached view. Raising a buffer threshold can change callback cadence without increasing delivered throughput. [WebRTC specification](https://www.w3.org/TR/webrtc/), [Chromium WebRTC source](https://chromium.googlesource.com/external/webrtc/+/master/pc/sctp_data_channel.cc).

3. **ICE latency is not SCTP latency.** Candidate-pair `currentRoundTripTime` comes from STUN connectivity checks. `availableOutgoingBitrate` describes an estimate for RTP streams and can be absent on a data-only connection. Neither is a browser API for SCTP congestion-window tuning. Socket discard counters describe errors handing packets to a socket; they do not count all network loss or SCTP retransmissions. [WebRTC Stats specification](https://www.w3.org/TR/webrtc-stats/).

4. **One browser process can share WebRTC threads across endpoints.** Chromium's dependency factory uses process-wide signaling and network threads. Two connections in one process are a different benchmark from two independently launched browsers. [Chromium dependency factory](https://chromium.googlesource.com/chromium/src/+/7f03b3baccc505fa0a006e795d8003388878eb3b/third_party/blink/renderer/modules/peerconnection/peer_connection_dependency_factory.cc).

5. **The signaling Worker is outside the file-data path.** PeerLink exchanges SDP, ICE, and room messages through it. File bytes pass through WebRTC, with TURN available as a fallback. Changing Cloudflare Worker throughput does not accelerate an established direct file channel.

## Decisions

Keep the existing approximately 64 KiB wire chunks, 256 KiB native send cap, bounded receive credit, per-chunk integrity checks, and acknowledgements after storage commits. No verified gain currently justifies another transfer-setting change. Exploratory packet-size and queue-size comparisons were inconclusive; raw harness runs with completion-ACK races must not be used as evidence of an improvement.

Add bounded diagnostic counters for event versus timeout wakes, post-wake buffer occupancy, receive timer batches, and native send retries. Extend the existing diagnostic snapshot with data-channel byte/message counts and candidate-pair packet/socket-discard counts. Missing browser statistics remain `null`, and a nominated-pair fallback is labeled separately from a transport-selected pair.

A useful next comparison must measure bytes received, enforce the queue cap after every wake, use unique transfer IDs and ordered start/end barriers, and verify completion. Raw data-channel measurements should bypass file reads, hashing, and storage; full-engine measurements must retain them and verify persisted bytes. Any claimed improvement needs matched conditions and repeated controls.

The UI currently shows the average since the file started, using 1024-based units labeled MB/s. This differs from an instantaneous rate. Changing that display would not increase transfer speed.

## Regression verification

Pause/resume completed an 8,388,731-byte file with exact persisted content. Cancellation rejected the send and removed its receiver record. Simultaneous bidirectional transfers verified 2,097,275 bytes in each direction. Integrity and queue-bound checks passed, with no page errors. TypeScript and the production Vite/PWA build passed; the build used the production signaling URL through a process environment override.
