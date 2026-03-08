import { useState } from "react";
import { useP2P } from "./hooks/useP2P";
import {
  Header,
  RoomConnection,
  FileUploader,
  SendQueue,
  ReceiveProgress,
  ReceivedFiles,
  FilePreviewModal,
  LogPanel,
  ChatPanel,
  SettingsModal,
} from "./components";
import type { FileMetadata } from "./ProgressDB";

function App() {
  const {
    roomId,
    roomType,
    connected,
    connectionType,
    logs,
    sendQueue,
    receivedFiles,
    currentReceiving,
    chatMessages,
    unreadCount,
    settings,
    username,
    isChatOpen,
    isSettingsOpen,
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
    sendChatMessage,
    updateSettings,
    setIsChatOpen,
    setIsSettingsOpen,
    generateRoomId,
  } = useP2P();

  const [previewFile, setPreviewFile] = useState<FileMetadata | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const handleFilesSelect = async (files: File[]) => {
    await addFilesToQueue(files);
  };

  const handlePreview = async (file: FileMetadata) => {
    setPreviewFile(file);
    const url = await openPreview(file);
    setPreviewUrl(url);
  };

  const handleClosePreview = () => {
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
    }
    setPreviewFile(null);
    setPreviewUrl(null);
  };

  return (
    <div className="app-container">
      <main className="main-content">
        <Header 
          onSettingsClick={() => setIsSettingsOpen(true)}
          onChatClick={() => setIsChatOpen(true)}
          unreadCount={unreadCount}
          connected={connected}
          username={username}
        />

        <RoomConnection
          roomId={roomId}
          onRoomIdChange={setRoomId}
          onJoin={join}
          connected={connected}
          connectionType={connectionType}
          roomType={roomType}
          generateRoomId={generateRoomId}
        />

        {connected && (
          <>
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
              onDownload={downloadFile}
              onPreview={handlePreview}
              onClearRoom={clearRoom}
            />
          </>
        )}

        <LogPanel logs={logs} />

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
          onSendMessage={sendChatMessage}
        />

        <SettingsModal
          isOpen={isSettingsOpen}
          onClose={() => setIsSettingsOpen(false)}
          settings={settings}
          onUpdateSettings={updateSettings}
        />
      </main>
    </div>
  );
}

export default App;