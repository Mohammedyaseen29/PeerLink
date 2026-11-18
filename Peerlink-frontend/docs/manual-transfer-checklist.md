# Manual transfer acceptance checklist

Record OS, browser version, sender/receiver roles, direct or relay route, available browser storage, selected count, completed count and failures. Mark an item passed only after executing it. Keep both tabs visible and devices awake for the first pass. Test backgrounding separately.

## Browser and network matrix

- [ ] Windows Chrome → phone Chrome and reverse, using the actual laptop that previously failed.
- [ ] Windows Brave → the same phone on the same Wi-Fi, using an unchanged test set.
- [ ] Edge ↔ Chrome.
- [ ] Firefox ↔ Chrome.
- [ ] macOS Safari ↔ Chrome and iPhone/iPad Safari ↔ desktop.
- [ ] Android Chrome and Brave, in both sender and receiver roles.
- [ ] Ordinary Wi-Fi, guest Wi-Fi and different networks recorded separately.
- [ ] Force relay only in a disposable test fixture and confirm a selected `relay` candidate in connection statistics. Retain a direct-first production policy.
- [ ] If Chrome alone fails before data-channel open, inspect its effective firewall/program rules, WebRTC policy and candidate errors. Do not disable the firewall or automatically change privacy/security settings.

## Selection and queue

- [ ] Pick 500+ mixed photos and videos, including duplicate names, different folders, Unicode names and an empty file.
- [ ] Verify selected count and total byte size before sending. Confirm transfer starts after **Send selected**.
- [ ] Deselect a subset, select all, remove individual files and clear the staged list.
- [ ] Send a subset and confirm unselected items remain staged.
- [ ] Pick the same file again after removing it. Confirm the native input is reset.
- [ ] Drop a directory with more than 100 entries and nested folders. Confirm all entries are counted. Test folder-picker fallback where folder drag/drop is unavailable.
- [ ] Scroll/page the preview list. Confirm thumbnails are bounded and URLs/video resources are released after removal and leaving.
- [ ] Check portrait/landscape photos and supported/unsupported video codecs. Confirm sending works for files whose previews are unavailable.

## Transfer correctness

- [ ] Send the entire 500+ file selection in one action. Compare completed IDs, counts and sizes against the selected manifest. Confirm each duplicate-name file has its own stored copy.
- [ ] Compare source and received bytes/hashes. The fixture must read and validate large files incrementally.
- [ ] Send a single file larger than 2 GiB, created/read incrementally, without a whole-file array allocation. Record peak queue/read bounds and browser memory observations.
- [ ] Confirm data frames include their header within the negotiated SCTP maximum. Test an artificially smaller maximum in a fixture.
- [ ] Send both directions concurrently. Confirm files in one outbound peer queue remain sequential.
- [ ] Progress reaches complete only after the receiver commits the verified data. Receipt and an OS download are separate states.
- [ ] Pause an active file for 30 seconds. Confirm progress is retained and resume continues the same attempt.
- [ ] Pause a waiting file. Confirm it starts after being resumed.
- [ ] Cancel mid-file. Confirm partial data is cleaned up and the next queued file still transfers.
- [ ] Retry a failed file. Confirm it uses a fresh attempt ID, restarts cleanly and safely ignores late messages from the previous attempt.
- [ ] Inject a corrupted hash, invalid sequence, missing chunk, storage error and closed channel. Each fails visibly instead of reporting success.
- [ ] Disconnect/reconnect, leave/rejoin and retry from either endpoint. Confirm stored complete files remain available in persistent rooms.
- [ ] Temporary-room data is removed after leaving, including interrupted transfers.

## Saving and persistence

- [ ] Download a complete small file with the save picker available.
- [ ] Without `showSaveFilePicker`, download through the same-origin service worker and verify exact content and filename.
- [ ] Save a 2 GiB+ received file in Firefox/Safari using streaming fallback; inspect memory rather than assuming the browser never buffers internally.
- [ ] Cancel a save dialog/download and retry. Confirm persisted received data remains intact.
- [ ] With an older service worker active and the update waiting, try a file above 32 MiB. Confirm the app asks you to apply the update, and the download works after updating.
- [ ] Refresh a persistent room and reopen stored complete files without the sender.
- [ ] Exhaust/limit browser storage in a disposable profile. Confirm an actionable error, a failed sender status and incomplete-data cleanup.
- [ ] Enable opt-in automatic download with many files. Confirm received files remain available for explicit download when browser permission blocks automatic saving.

## UX and diagnostics

- [ ] Keyboard and touch controls work at mobile widths and 200% zoom. Controls have meaningful names and visible focus.
- [ ] Per-file and overall progress, speed and ETA represent actual committed bytes. Confirm paused time is accounted for.
- [ ] Error text identifies the action the user can take.
- [ ] Connection diagnostics include state changes, candidate types/errors and negotiated size, without SDP, IP addresses, credentials or file contents.
- [ ] QR display, camera scan, invite link, preview and update prompt still work. Updates do not reload an active transfer automatically.

## Result labels

Use **passed**, **failed**, **not run**, or **blocked**, with the exact fixture/device. Record simulated, same-host and physical two-device results separately. Each browser in the matrix needs its own result.
