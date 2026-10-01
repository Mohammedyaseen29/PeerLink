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
import { CircleAlert, CircleCheck, Info, LoaderCircle, RefreshCw, WifiOff, X } from "lucide-react";

function App() {
  const [appUpdateReady, setAppUpdateReady] = useState(false);
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
    selectedPeerIds,
    setSelectedPeerIds,
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
  } = useP2P();
  const inRoomRef = useRef(inRoom);
  inRoomRef.current = inRoom;

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
    const workerPath = import.meta.env.DEV ? '/dev-sw.js?dev-sw' : '/sw.js';
    const workerType: WorkerType = import.meta.env.DEV ? 'module' : 'classic';
    void navigator.serviceWorker.register(workerPath, { scope: '/', type: workerType }).then(value => {
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

  const handleFilesSelect = async (files: File[]) => {
    await addFilesToQueue(files);
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

  const handleClosePreview = () => {
    previewRequest.current++;
    if (previewFile) closePreview(previewFile.fileId);
    if (previewUrl) {
      void releasePreviewUrl(previewUrl);
    }
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
    if (previewFile && !onlineFiles.some(file => file.fileId === previewFile.fileId) &&
        !receivedFiles.some(file => file.fileId === previewFile.fileId)) handleClosePreview();
  // Close a local preview if its stored file was deleted.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receivedFiles, onlineFiles]);

  return (
    <div className="app-container">
      <main className="main-content">
        <Header 
          onSettingsClick={() => setIsSettingsOpen(true)}
          onChatClick={() => setIsChatOpen(true)}
          unreadCount={unreadCount}
          connected={connected}
          username={username}
          avatar={settings.avatar}
        />

        {appUpdateReady && (
          <div className="room-status app-update-banner" role="status" aria-live="polite">
            <div className="room-status-icon"><RefreshCw size={20} /></div>
            <div className="room-status-copy">
              <strong>PeerLink update ready</strong>
              <span>{inRoom ? "Leave the room after transfers finish to install the update." : "Install the latest version to keep room members on the same app version."}</span>
            </div>
            <button type="button" className="room-status-retry" disabled={inRoom} onClick={() => {
              if (inRoom) return;
              const waitingWorker = serviceWorkerRegistration.current?.waiting;
              if (waitingWorker) {
                reloadAfterControlChange.current = true;
                waitingWorker.postMessage({ type: 'SKIP_WAITING' });
              } else {
                window.location.reload();
              }
            }}>
              {inRoom ? 'Leave room to update' : 'Update now'}
            </button>
            <button type="button" className="toast-dismiss" onClick={() => setAppUpdateReady(false)} aria-label="Dismiss update notice"><X size={16} /></button>
          </div>
        )}

        <RoomConnection
          key={connectionFormKey}
          roomId={roomId}
          onRoomIdChange={setRoomId}
          onJoin={join}
          onLeave={() => { handleClosePreview(); leaveRoom(); }}
          connected={connected}
          inRoom={inRoom}
          connectionType={connectionType}
          signalingStatus={signalingStatus}
          roomType={roomType}
          generateRoomId={generateRoomId}
          avatar={settings.avatar}
        />

        {inRoom && (
          <>
            {!connected && (
              <div className={`room-status ${signalingStatus === "offline" ? "room-status-offline" : ""}`} role="status" aria-live="polite">
                <div className="room-status-icon">
                  {signalingStatus === "offline" ? <WifiOff size={20} /> : <LoaderCircle size={20} className="room-status-spinner" />}
                </div>
                <div className="room-status-copy">
                  <strong>{signalingStatus === "connecting" ? "Connecting to room" : signalingStatus === "negotiating" ? "Securing peer connection" : signalingStatus === "offline" ? "Room is offline" : "Waiting for your peer"}</strong>
                  <span>{signalingStatus === "offline" ? "Stored files are ready to preview or download. Reconnect when you're ready to share." : signalingStatus === "negotiating" ? "Establishing a direct transfer path." : signalingStatus === "connecting" ? "Checking the room and loading saved files." : "Share the room ID to start transferring."}</span>
                </div>
                {signalingStatus === "offline" && <button type="button" className="room-status-retry" onClick={retryConnection}><RefreshCw size={15} /> Retry</button>}
              </div>
            )}

            <GroupMembers
              members={members}
              selectedPeerIds={selectedPeerIds}
              onSelectionChange={setSelectedPeerIds}
              username={username}
              avatar={settings.avatar}
              selfOnline={signalingStatus !== "offline"}
              onRetryPeer={retryPeerConnection}
            />

            <FileUploader
              onFilesSelect={handleFilesSelect}
              disabled={!connected || selectedPeerIds.length === 0}
            />

            <SendQueue
              queue={sendQueue}
              onPause={pauseSending}
              onResume={resumeSending}
              onRemove={removeFromQueue}
              onClearAll={clearAllQueue}
            />

            {currentReceivings.length > 0 && (
              <ReceiveProgress receivings={currentReceivings} />
            )}

            <ReceivedFiles
              files={receivedFiles}
              onlineFiles={onlineFiles}
              onDownload={downloadFile}
              onPreview={handlePreview}
              onDelete={deleteReceivedFile}
              onClearRoom={clearRoom}
            />
          </>
        )}

        {toast && (
          <div className="toast-overlay">
            <div className={`toast-body toast-${toast.kind}`} role={toast.kind === "error" ? "alert" : "status"}>
              <span className="toast-icon">{toast.kind === "success" ? <CircleCheck size={20} /> : toast.kind === "info" ? <Info size={20} /> : <CircleAlert size={20} />}</span>
              <span className="toast-message-text">{toast.message}</span>
              <button type="button" className="toast-dismiss" onClick={dismissToast} aria-label="Dismiss notification"><X size={16} /></button>
            </div>
          </div>
        )}

        {previewFile && (
          <FilePreviewModal
            file={previewFile}
            previewUrl={previewUrl}
            onClose={handleClosePreview}
          />
        )}

        <ChatPanel
          isOpen={isChatOpen}
          onClose={() => setIsChatOpen(false)}
          messages={chatMessages}
          selfPeerId={selfPeerId}
          username={username}
          avatar={settings.avatar}
          onSendMessage={sendChatMessage}
        />

        <SettingsModal
          isOpen={isSettingsOpen}
          onClose={() => setIsSettingsOpen(false)}
          settings={settings}
          avatar={settings.avatar}
          onUpdateSettings={updateSettings}
        />
      </main>
    </div>
  );
}

export default App;
