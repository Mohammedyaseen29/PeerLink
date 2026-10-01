# PeerLink

PeerLink transfers files directly between browser peers. Rooms support two members using a direct WebRTC connection. Data channels apply backpressure while chunks are in flight. See the [WebRTC peer connection guide](https://webrtc.org/getting-started/peer-connections) and [MDN data channel guide](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Using_data_channels).

The signaling Worker exchanges room membership, SDP, and ICE messages. It does not relay file contents. WebRTC may use the configured TURN server when a direct network path is unavailable. Files and their catalog entries are shared with the connected peer.

Persistent rooms keep received copies in that browser's IndexedDB so they can be reopened later. Temporary room copies are removed when the user leaves. Storage belongs to each device; it is not shared across members.
