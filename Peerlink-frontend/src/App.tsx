import { useEffect, useRef, useState } from "react";
import { useP2P } from "./hooks/useP2P";
import {
  Header,
  RoomConnection,
  FileUploader,
  SendQueue,
  ReceiveProgress,
  ReceivedFiles,
  FilePreviewModal,
  ChatPanel,
  SettingsModal,
} from "./components";
import { releasePreviewUrl, type FileMetadata } from "./ProgressDB";

function App() {
  const {
    roomId,
    roomType,
    connected,
    connectionType,
    sendQueue,
    receivedFiles,
    onlineFiles,
    connectionFormKey,
    currentReceiving,
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
    addFilesToQueue,
    pauseSending,
    resumeSending,
    removeFromQueue,
    clearAllQueue,
    downloadFile,
    clearRoom,
    openPreview,
    closePreview,
    sendChatMessage,
    updateSettings,
    setIsChatOpen,
    setIsSettingsOpen,
    generateRoomId,
    dismissToast,
  } = useP2P();

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
      if (request === previewRequest.current) window.alert(error instanceof Error ? error.message : String(error));
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

        <RoomConnection
          key={connectionFormKey}
          roomId={roomId}
          onRoomIdChange={setRoomId}
          onJoin={join}
          connected={connected}
          inRoom={inRoom}
          connectionType={connectionType}
          roomType={roomType}
          generateRoomId={generateRoomId}
          avatar={settings.avatar}
        />

        {inRoom && (
          <>
            {!connected && (
              <div className="waiting-banner">
                <div className="waiting-banner-content">
                  <span className="waiting-banner-spinner">⟳</span>
                  <span className="waiting-banner-text">Waiting for other user...</span>
                </div>
              </div>
            )}

            <FileUploader
              onFilesSelect={handleFilesSelect}
              disabled={!connected}
            />

            <SendQueue
              queue={sendQueue}
              onPause={pauseSending}
              onResume={resumeSending}
              onRemove={removeFromQueue}
              onClearAll={clearAllQueue}
            />

            {currentReceiving && (
              <ReceiveProgress receiving={currentReceiving} />
            )}

            <ReceivedFiles
              files={receivedFiles}
              onlineFiles={onlineFiles}
              onDownload={downloadFile}
              onPreview={handlePreview}
              onClearRoom={clearRoom}
            />
          </>
        )}

        {toast && toast.visible && (
          <div className="toast-overlay" onClick={dismissToast}>
            <div className="toast-body" onClick={(e) => e.stopPropagation()}>
              <span className="toast-icon">✓</span>
              <span className="toast-message-text">{toast.message}</span>
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
