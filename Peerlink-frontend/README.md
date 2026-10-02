# PeerLink

PeerLink transfers files directly between browser peers. Rooms support two members using a direct WebRTC connection. Data channels apply backpressure while chunks are in flight. See the [WebRTC peer connection guide](https://webrtc.org/getting-started/peer-connections) and [MDN data channel guide](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Using_data_channels).

The signaling Worker exchanges room membership, SDP, and ICE messages. It does not relay file contents. WebRTC may use the configured TURN server when a direct network path is unavailable. Files and their catalog entries are shared with the connected peer.

Persistent rooms keep received copies in that browser's IndexedDB so they can be reopened later. Temporary room copies are removed when the user leaves. Storage belongs to each device; it is not shared across members.

## File previews

Previewable files in the send queue use a browser object URL for the selected `File` directly, so opening a preview does not assemble another whole-file buffer in memory. If the browser did not supply a file MIME type, PeerLink infers common media and document types from the filename. HTML text previews run in a sandboxed frame.

## Large-file transfers

Transfers use approximately 64 KiB chunks. The sender reads an initial 16-chunk batch, then reads batches of up to 32 chunks (about 2 MiB) while sending the current batch. The receiver checks each chunk's SHA-256 hash and saves up to 32 ordered chunks in one IndexedDB transaction. While that transaction commits, it can hash one following batch. Progress and sender credit advance only after the transaction completes. Partial receive batches coalesce for up to 32 ms.

Sender credit caps sent-but-uncommitted data at 128 chunks (about 8 MiB), and the receiver accepts at most 128 uncommitted chunks (about 8 MiB), including the active batch, a batch being checked, and queued chunks. Sender read staging is separate: the current and prefetched batches together hold up to about 4 MiB after startup. The data channel also applies a 2 MiB backpressure threshold. Actual speed depends on the browser, local storage, CPU, and network path; the larger batches and hash/storage overlap reduce avoidable per-batch waiting but do not promise a particular throughput.
