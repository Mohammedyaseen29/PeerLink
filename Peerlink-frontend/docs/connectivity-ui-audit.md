# PeerLink interface audit

## Interface findings

| Area | Finding | Design change |
| --- | --- | --- |
| Room workflow | Create and join input fields used placeholders as labels. Pasted invitation URLs needed a different entry point. | Label the room fields, submit through native forms and accept a PeerLink invite URL in the join field. |
| Room header | The room ID, sharing action and connection controls occupied several rows, pushing file selection down the page. | Group the room identity and connection route together. Keep QR and copy available as explicit controls. |
| Recovery | The status panel and roster both exposed retry on the same peer failure. At 390px, the diagnostics button squeezed the status text into a narrow column. | Put recovery in one place and give status copy its own row at narrow widths. Offer selectable diagnostics when clipboard access fails. |
| Touch and readable text | Room copy controls measured 28–32 CSS pixels high. At 390px, the action row could collapse a saved filename to zero width. Mobile action labels were visually hidden without an accessible name. | Keep filenames and details beside the file icon, put labeled actions on a second row, and raise functional text contrast. |
| Queue safety | Clearing a queue could cancel an active send immediately. | Ask for confirmation when there are active or pending items. Allow a completed queue to be cleared directly. |

The touch controls target 44 CSS pixels. On the room card, the contrast ratio for room-type hints and room-choice descriptions rises from 2.25:1 to 6.97:1. The room and transfer layouts retain PeerLink's dark palette and IBM Plex Mono. [WCAG target size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced.html) · [WCAG text contrast](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)

The Chrome UI check at 320, 390 and 1,280 pixels passed keyboard submission, invalid-ID feedback, pasted invite entry, QR dialog open and Escape-to-close, and no horizontal overflow. The sampled saved filename was readable at all three widths. Download, Preview, and Delete each measured at least 44 by 44 CSS pixels. At both phone widths the status text had its own row above the diagnostics button. Dismissing queue confirmation preserved the queue, and accepting it invoked the clear action.

## Connection observations made before the UI-only decision

- **Chrome and Brave on Windows.** The live app established a direct connection. The receivers verified 32,771 bytes from Chrome and 49,169 bytes from Brave against their expected SHA-256 hashes.
- **Laptop Chrome and the user's Android Chrome on Wi-Fi.** The room connected directly and the selected pair used host candidates. The sender did not reach a confirmed completion during the test window. File delivery remains unverified.
- **Relay-only smoke test.** The configured relay returned no relay candidates in the test window, and the browser reported ICE error 701. The user narrowed this work to the interface before a provider migration.
- **WebKit.** The Windows test runtime lacks `RTCPeerConnection`. The new local view showed a seeded saved file with a readable name, a 44px download control and no horizontal overflow at 390px. The final run did not observe a download event. Transfers and downloads in real Safari on macOS and iOS remain unverified.
