# PeerLink

PeerLink transfers files directly between browser peers. Rooms support up to four members using a full mesh of WebRTC connections. Each browser can send to at most two peers at once; data channels apply backpressure while chunks are in flight. See the [WebRTC peer connection guide](https://webrtc.org/getting-started/peer-connections) and [MDN data channel guide](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Using_data_channels).

The signaling Worker exchanges room membership, SDP, and ICE messages. It does not relay file contents. WebRTC may use the configured TURN server when a direct network path is unavailable. Group sends create a separate transfer for each selected recipient, and only those recipients receive that file's catalog entry.

Persistent rooms keep received copies in that browser's IndexedDB so they can be reopened later. Temporary room copies are removed when the user leaves. Storage belongs to each device; it is not shared across members.
