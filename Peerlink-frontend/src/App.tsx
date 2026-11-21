import { useEffect, useRef, useState } from "react";
import { useP2P } from "./hooks/useP2P";
import {
  Header,
  RoomConnection,
  FileUploader,
  SendQueue,
  ReceiveProgress,
  ReceivedFiles,
  GroupMembers,
  FilePreviewModal,
  ChatPanel,
  SettingsModal,
} from "./components";
import { releasePreviewUrl, type FileMetadata } from "./ProgressDB";
import { getFileMimeType } from "./utils/helpers";
import type { QueuedFile, RoomType, SignalingStatus } from "./types";
import { registerPeerLinkServiceWorker } from "./serviceWorker";
import { CircleAlert, CircleCheck, Copy, FolderOpen, Info, LoaderCircle, MessageCircle, RefreshCw, ShieldCheck, UserPlus, WifiOff, X } from "lucide-react";
import { parseRoomInvite } from "./utils/roomInvite";
import { BrandMark } from "./components/BrandMark";

function getRoomStatusCopy(status: SignalingStatus, roomType: RoomType, canRetryPeer: boolean) {
  switch (status) {
    case "unsupported":
      return {
        title: "Peer transfers unavailable in this browser",
        message: roomType === "temporary"
          ? "Temporary rooms need a browser with WebRTC support. Open PeerLink in a supported browser to transfer files."
          : "Open PeerLink in a browser with WebRTC support to connect. Files already saved on this device remain available below.",
      };
    case "connecting":
      return { title: "Connecting to room", message: "Checking the room and loading saved files." };
    case "negotiating":
      return { title: "Connecting to your peer", message: "Both devices are in the room. Keep this page open while they connect." };
    case "offline":
      return { title: "Room is offline", message: "Stored files are ready to preview or download. Retry when you're ready to share." };
    case "full":
      return { title: "Room is full", message: "Rooms support up to two people. Saved files on this device remain available below." };
    case "unreachable":
      return {
        title: "Could not connect to peer",
        message: canRetryPeer
          ? "The peer is in the room, but the connection could not be established. Retry from their room member row."
          : "The peer is in the room, but the connection could not be established. Leave and reopen this room to retry.",
      };
    case "waiting":
    case "idle":
    default:
      return { title: "Waiting for your peer", message: "Share the QR code or room ID with the other device." };
  }
}

function App() {
  const [appUpdateReady, setAppUpdateReady] = useState(false);
  const [copyingDiagnostics, setCopyingDiagnostics] = useState(false);
  const [manualDiagnostics, setManualDiagnostics] = useState<string | null>(null);
  const serviceWorkerRegistration = useRef<ServiceWorkerRegistration | null>(null);
  const reloadAfterControlChange = useRef(false);
  const {
    roomId,
    roomType,
    connected,
    connectionType,
    signalingStatus,
    sendQueue,
    receivedFiles,
    onlineFiles,
    connectionFormKey,
    currentReceivings,
    members,
    selfPeerId,
    chatMessages,
    unreadCount,
    settings,
    username,
    isChatOpen,
    isSettingsOpen,
    inRoom,
    toast,
    setRoomId,
    join,
    leaveRoom,
    retryConnection,
    retryPeerConnection,
    retrySending,
    addFilesToQueue,
    pauseSending,
    resumeSending,
    removeFromQueue,
    clearAllQueue,
    downloadFile,
    clearRoom,
    deleteReceivedFile,
    openPreview,
    closePreview,
    sendChatMessage,
    updateSettings,
    setIsChatOpen,
    setIsSettingsOpen,
    generateRoomId,
    dismissToast,
    notifyError,
    getTransferDiagnostics,
  } = useP2P();
  const unsupportedBrowser = signalingStatus === "unsupported";
  const showTransferControls = !unsupportedBrowser && signalingStatus !== "full";
  const showRoomMembers = showTransferControls && members.length > 0;
  const canCopyConnectionDetails = signalingStatus === "negotiating" || signalingStatus === "offline" || signalingStatus === "unreachable";
  const connectionProblem = signalingStatus === "offline" || signalingStatus === "full" || signalingStatus === "unreachable";
  const RoomStatusIcon = connectionProblem || unsupportedBrowser ? WifiOff : signalingStatus === "waiting" ? UserPlus : LoaderCircle;
  const canRetryPeer = members.some(member => member.status === "disconnected" && member.supportsReconnect === true);
  const { title: roomStatusTitle, message: roomStatusMessage } = getRoomStatusCopy(signalingStatus, roomType, canRetryPeer);
  const inRoomRef = useRef(inRoom);
  inRoomRef.current = inRoom;
  const inviteAttempted = useRef(false);

  useEffect(() => {
    let timer: number | null = null;
    const scheduleInvite = (fromNavigation = false) => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      if (inRoomRef.current) {
        inviteAttempted.current = true;
        return;
      }
      if (fromNavigation) inviteAttempted.current = false;
      if (inviteAttempted.current) return;

      const invite = parseRoomInvite(window.location.href);
      if (!invite) return;
      timer = window.setTimeout(() => {
        timer = null;
        if (inRoomRef.current) {
          inviteAttempted.current = true;
          return;
        }
        if (inviteAttempted.current) return;

        inviteAttempted.current = true;
        window.history.replaceState(window.history.state, "", `${window.location.pathname}${window.location.search}`);
        join(invite.roomId, invite.roomType);
      }, 0);
    };
    const handleNavigation = () => scheduleInvite(true);

    scheduleInvite();
    window.addEventListener("hashchange", handleNavigation);
    window.addEventListener("popstate", handleNavigation);
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      window.removeEventListener("hashchange", handleNavigation);
      window.removeEventListener("popstate", handleNavigation);
    };
  }, [inRoom, join]);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    let disposed = false;
    let hadController = Boolean(navigator.serviceWorker.controller);
    let registration: ServiceWorkerRegistration | null = null;
    let installingWorker: ServiceWorker | null = null;
    const onWorkerStateChange = () => {
      if (installingWorker?.state === 'installed' && navigator.serviceWorker.controller) setAppUpdateReady(true);
    };
    const onUpdateFound = () => {
      installingWorker?.removeEventListener('statechange', onWorkerStateChange);
      installingWorker = registration?.installing ?? null;
      installingWorker?.addEventListener('statechange', onWorkerStateChange);
      onWorkerStateChange();
    };
    const onWindowFocus = () => { void registration?.update().catch(() => undefined); };
    const onControllerChange = () => {
      if (disposed) return;
      if (reloadAfterControlChange.current) {
        reloadAfterControlChange.current = false;
        if (!inRoomRef.current) window.location.reload();
        else setAppUpdateReady(true);
      } else if (hadController) {
        setAppUpdateReady(true);
      }
      hadController = true;
    };
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);
    window.addEventListener('focus', onWindowFocus);
    void registerPeerLinkServiceWorker().then(value => {
      if (disposed) return;
      registration = value;
      serviceWorkerRegistration.current = value;
      value.addEventListener('updatefound', onUpdateFound);
      if (value.installing) onUpdateFound();
      if (value.waiting) setAppUpdateReady(true);
      void value.update().catch(() => undefined);
    }).catch(() => undefined);
    return () => {
      disposed = true;
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
      window.removeEventListener('focus', onWindowFocus);
      registration?.removeEventListener('updatefound', onUpdateFound);
      installingWorker?.removeEventListener('statechange', onWorkerStateChange);
    };
  }, []);

  const [previewFile, setPreviewFile] = useState<FileMetadata | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const previewRequest = useRef(0);
  useEffect(() => () => { previewRequest.current++; }, []);
  useEffect(() => () => { if (previewUrl) void releasePreviewUrl(previewUrl); }, [previewUrl]);
  useEffect(() => () => { if (previewFile) closePreview(previewFile.fileId); }, [previewFile, closePreview]);

  const handleFilesSelect = async (files: File[]): Promise<boolean> => {
    return await addFilesToQueue(files);
  };

  const handleCopyDiagnostics = async () => {
    setCopyingDiagnostics(true);
    setManualDiagnostics(null);
    try {
      let details: unknown;
      try {
        details = await getTransferDiagnostics();
      } catch (error) {
        notifyError(`Unable to collect connection details: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      const serialized = JSON.stringify(details, null, 2);
      try {
        if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable in this browser.");
        await navigator.clipboard.writeText(serialized);
        notifyError("Connection details copied.", "success");
      } catch {
        setManualDiagnostics(serialized);
        notifyError("Connection details are ready below. Select and copy them manually.", "info");
      }
    } catch (error) {
      notifyError(`Unable to copy connection details: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setCopyingDiagnostics(false);
    }
  };

  const handlePreview = async (file: FileMetadata) => {
    const request = ++previewRequest.current;
    try {
      const url = await openPreview(file);
      if (request !== previewRequest.current) { void releasePreviewUrl(url); return; }
      setPreviewFile(file);
      setPreviewUrl(url);
    } catch (error) {
      if (request === previewRequest.current) notifyError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleQueuedPreview = (queuedFile: QueuedFile) => {
    previewRequest.current++;
    const { file, id } = queuedFile;
    const mimeType = getFileMimeType(file);
    const previewBlob = mimeType === file.type ? file : file.slice(0, file.size, mimeType);
    const url = URL.createObjectURL(previewBlob);
    setPreviewFile({
      fileId: `q-${id}`,
      roomId,
      name: file.name,
      path: (file as File & { webkitRelativePath?: string }).webkitRelativePath,
      size: file.size,
      mimeType,
      totalChunks: queuedFile.totalChunks,
      receivedChunks: queuedFile.totalChunks,
      status: "complete",
      createdAt: Date.now(),
    });
    setPreviewUrl(url);
  };

  const handleClosePreview = () => {
    previewRequest.current++;
    if (previewFile) closePreview(previewFile.fileId);
    setPreviewFile(null);
    setPreviewUrl(null);
  };

  useEffect(() => {
    if (!previewFile || !previewUrl?.includes("/__peerlink_preview/")) return;
    if (onlineFiles.some((file) => file.fileId === previewFile.fileId)) return;
    previewRequest.current++;
    closePreview(previewFile.fileId);
    void releasePreviewUrl(previewUrl);
    setPreviewFile(null);
    setPreviewUrl(null);
  }, [onlineFiles, previewFile, previewUrl, closePreview]);

  useEffect(() => {
    if (!previewFile) return;
    if (previewFile.fileId.startsWith("q-")) {
      const queuedId = previewFile.fileId.slice(2);
      if (sendQueue.some((file) => file.id === queuedId)) return;
      previewRequest.current++;
      closePreview(previewFile.fileId);
      setPreviewFile(null);
      setPreviewUrl(null);
      return;
    }
    if (!onlineFiles.some(file => file.fileId === previewFile.fileId) &&
        !receivedFiles.some(file => file.fileId === previewFile.fileId)) handleClosePreview();
  // Close a local preview if its stored file was deleted.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receivedFiles, onlineFiles, sendQueue, previewFile]);

  return (
    <div className="app-container peerlink-app">
      <div className="ambient-light" aria-hidden="true" />
      <Header
        onSettingsClick={() => setIsSettingsOpen(true)}
        onChatClick={() => setIsChatOpen(true)}
        unreadCount={unreadCount}
        connected={connected}
        username={username}
        avatar={settings.avatar}
        isChatOpen={isChatOpen}
      />
      <main className="main-content" id="transfer-workspace">
        {appUpdateReady && (
          <div className="room-status app-update-banner" role="status" aria-live="polite">
            <div className="room-status-icon"><RefreshCw size={20} /></div>
            <div className="room-status-copy">
              <strong>PeerLink update ready</strong>
              <span>{inRoom ? "Leave the room after transfers finish to install the update." : "Install the latest version to keep both devices on the same app version."}</span>
            </div>
            <button type="button" className="room-status-retry" disabled={inRoom} onClick={() => {
              if (inRoom) return;
              const waitingWorker = serviceWorkerRegistration.current?.waiting;
              if (waitingWorker) {
                reloadAfterControlChange.current = true;
                waitingWorker.postMessage({ type: 'SKIP_WAITING' });
              } else window.location.reload();
            }}>{inRoom ? "Leave room to update" : "Update now"}</button>
            <button type="button" className="toast-dismiss" onClick={() => setAppUpdateReady(false)} aria-label="Dismiss update notice"><X size={16} /></button>
          </div>
        )}
        <header className="page-heading">
          <div className="headline-group">
            <div className="headline-kicker"><span className="kicker-line" />A DIRECT CONNECTION. A SHARED SPACE.</div>
            <h1>Make the <span>handoff.</span></h1>
          </div>
          <p className="intro-description">Files, folders, and a conversation.<br /> From your device, straight to theirs.</p>
        </header>
        <div className="handoff-grid">
          <div className="room-column">
            <RoomConnection
              key={connectionFormKey}
              roomId={roomId}
              onRoomIdChange={setRoomId}
              onJoin={join}
              onLeave={() => { setManualDiagnostics(null); handleClosePreview(); leaveRoom(); }}
              onReconnect={signalingStatus === "offline" ? retryConnection : canRetryPeer ? () => {
                for (const member of members) {
                  if (member.status === "disconnected" && member.supportsReconnect) retryPeerConnection(member.peerId);
                }
              } : undefined}
              connected={connected}
              inRoom={inRoom}
              connectionType={connectionType}
              signalingStatus={signalingStatus}
              roomType={roomType}
              generateRoomId={generateRoomId}
              avatar={settings.avatar}
            />
          </div>
          <div className="send-column">
            {showTransferControls ? <FileUploader onFilesSelect={handleFilesSelect} canSend={connected} /> : (
              <section className="unavailable-transfer glass-card"><WifiOff size={28} /><h2>{unsupportedBrowser ? "A different browser, same files." : "This room is full."}</h2><p>{unsupportedBrowser ? "Open PeerLink in a WebRTC-capable browser to share. Your saved files remain available below." : "Each room connects two devices. Leave this room to create another."}</p></section>
            )}
          </div>
        </div>
        {inRoom && (!connected || signalingStatus === "offline") && (
          <section className={"room-status workspace-room-status " + (connectionProblem ? "room-status-offline" : unsupportedBrowser ? "room-status-local" : "")} aria-label="Connection status">
            <div className="room-status-icon" aria-hidden="true"><RoomStatusIcon size={19} className={RoomStatusIcon === LoaderCircle ? "room-status-spinner" : undefined} /></div>
            <div className="room-status-copy" role="status" aria-live="polite">
              <strong>{connected && signalingStatus === "offline" ? "Reconnecting the room service" : roomStatusTitle}</strong>
              <span>{connected && signalingStatus === "offline" ? "Your direct file connection stays active while the room reconnects." : roomStatusMessage}</span>
            </div>
            {canCopyConnectionDetails && <div className="workspace-status-actions">
              {signalingStatus === "offline" && <button type="button" className="room-status-retry" onClick={retryConnection}><RefreshCw size={15} />Retry</button>}
              <button type="button" className="room-status-retry diagnostics-copy" onClick={() => void handleCopyDiagnostics()} disabled={copyingDiagnostics}><Copy size={15} />{copyingDiagnostics ? "Copying…" : "Connection details"}</button>
            </div>}
          </section>
        )}
        {showRoomMembers && <GroupMembers members={members} username={username} avatar={settings.avatar} selfOnline={signalingStatus !== "offline"} onRetryPeer={retryPeerConnection} />}
        {manualDiagnostics && <section className="connection-details-fallback glass-card" aria-label="Manual connection details copy">
          <label htmlFor="connection-details-text">Connection details — select and copy</label>
          <textarea id="connection-details-text" readOnly value={manualDiagnostics} rows={6} onFocus={event => event.currentTarget.select()} />
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setManualDiagnostics(null)}>Dismiss details</button>
        </section>}
        <section className="activity-section" aria-labelledby="activity-title">
          <div className="activity-heading">
            <div><span className="eyebrow">THE SHARED SPACE</span><h2 id="activity-title">In the room.</h2></div>
            <button type="button" className="activity-chat-link" onClick={() => setIsChatOpen(true)}><MessageCircle size={16} /><span>Room chat</span>{unreadCount > 0 && <span className="activity-unread">{unreadCount}</span>}</button>
          </div>
          <div className="transfer-workspace">
            <div className="outgoing-column">
              {sendQueue.length ? <SendQueue queue={sendQueue} onPause={pauseSending} onResume={resumeSending} onRetry={retrySending} onRemove={removeFromQueue} onClearAll={clearAllQueue} onPreview={handleQueuedPreview} /> : (
                <div className="handoff-guide"><div className="guide-symbol"><BrandMark /></div><h3>A room. Two devices.<br />Everything between you.</h3><p>Create a temporary room for a quick exchange, or a persistent room to keep your received files on this device.</p><div className="guide-features"><span><FolderOpen size={14} />Full folders welcome</span><span><MessageCircle size={14} />Chat as you share</span></div></div>
              )}
            </div>
            <div className="incoming-column">
              {showTransferControls && currentReceivings.length > 0 && <ReceiveProgress receivings={currentReceivings} />}
              <ReceivedFiles files={receivedFiles} onlineFiles={onlineFiles} onDownload={downloadFile} onPreview={handlePreview} onDelete={deleteReceivedFile} onClearRoom={clearRoom} />
            </div>
          </div>
        </section>
        <footer className="workspace-footer"><span><ShieldCheck size={14} />Encrypted in transit. No account needed.</span><span>Keep both devices open. We’ll handle the handoff.</span></footer>
      </main>
      {toast && <div className="toast-overlay"><div className={"toast-body toast-" + toast.kind} role={toast.kind === "error" ? "alert" : "status"}>
        <span className="toast-icon">{toast.kind === "success" ? <CircleCheck size={20} /> : toast.kind === "info" ? <Info size={20} /> : <CircleAlert size={20} />}</span>
        <span className="toast-message-text">{toast.message}</span><button type="button" className="toast-dismiss" onClick={dismissToast} aria-label="Dismiss notification"><X size={16} /></button>
      </div></div>}
      {previewFile && <FilePreviewModal file={previewFile} previewUrl={previewUrl} onClose={handleClosePreview} />}
      <ChatPanel isOpen={isChatOpen} onClose={() => setIsChatOpen(false)} messages={chatMessages} selfPeerId={selfPeerId} username={username} avatar={settings.avatar} onSendMessage={sendChatMessage} connected={connected} roomId={inRoom ? roomId : ""} />
      <SettingsModal isOpen={isSettingsOpen} onClose={() => setIsSettingsOpen(false)} settings={settings} username={username} avatar={settings.avatar} onUpdateSettings={updateSettings} />
    </div>
  );
}

export default App;
