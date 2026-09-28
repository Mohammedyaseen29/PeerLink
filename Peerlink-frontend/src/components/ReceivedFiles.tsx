import {
    Download,
    Eye,
    Trash2,
    FileImage,
    FileVideo,
    FileAudio,
    FileText,
    File,
    Archive,
} from "lucide-react";
import type { FileMetadata } from "../ProgressDB";
import { formatBytes, isPreviewable, getFileIconType } from "../utils/helpers";

interface ReceivedFilesProps {
    files: FileMetadata[];
    onlineFiles: FileMetadata[];
    onDownload: (file: FileMetadata) => void;
    onPreview: (file: FileMetadata) => void;
    onDelete: (file: FileMetadata) => void;
    onClearRoom: () => void;
}

const fileIcons = {
    image: FileImage,
    video: FileVideo,
    audio: FileAudio,
    pdf: FileText,
    text: FileText,
    archive: Archive,
    file: File,
};

export function ReceivedFiles({
    files,
    onlineFiles,
    onDownload,
    onPreview,
    onDelete,
    onClearRoom,
}: ReceivedFilesProps) {
    const renderFiles = (entries: FileMetadata[], online: boolean) => (
        <div className="files-list">
            {entries.map((file) => {
                const iconType = getFileIconType(file.mimeType);
                const Icon = fileIcons[iconType as keyof typeof fileIcons] || File;

                return (
                    <div key={`${online ? "online" : "received"}:${file.fileId}`} className="file-item">
                        <div className="file-icon"><Icon size={24} /></div>
                        <div className="file-info">
                            <span className="file-name">{file.name}</span>
                            {file.path && <span className="file-path">{file.path}</span>}
                            <span className="file-size">{formatBytes(file.size)}</span>
                        </div>
                        <div className="file-actions">
                            {!online && (
                                <button onClick={() => onDownload(file)} className="btn btn-primary btn-sm">
                                    <Download size={16} /><span>Download</span>
                                </button>
                            )}
                            {isPreviewable(file.mimeType) && (
                                <button onClick={() => onPreview(file)} className="btn btn-secondary btn-sm">
                                    <Eye size={16} /><span>Preview</span>
                                </button>
                            )}
                            {!online && (
                                <button onClick={() => onDelete(file)} className="btn-icon btn-danger-text" aria-label={`Delete ${file.name}`} title="Delete stored file">
                                    <Trash2 size={16} />
                                </button>
                            )}
                        </div>
                    </div>
                );
            })}
        </div>
    );

    return (
        <div className="received-files glass-card">
            {onlineFiles.length > 0 && (
                <section className="online-peer-files">
                    <div className="section-header">
                        <h3 className="section-title">Available on Peer</h3>
                        <span className="file-size">{onlineFiles.length} {onlineFiles.length === 1 ? "file" : "files"}</span>
                    </div>
                    {renderFiles(onlineFiles, true)}
                </section>
            )}

            <section className="local-received-files">
                <div className="section-header">
                    <h3 className="section-title">Stored on this device</h3>
                    {files.length > 0 && (
                        <button onClick={onClearRoom} className="btn-icon btn-danger-text">
                            <Trash2 size={16} />
                            <span>Clear Room</span>
                        </button>
                    )}
                </div>

                {files.length === 0 ? (
                    <div className="empty-state">
                        <Download size={48} className="empty-icon" />
                        <p>No files received on this device yet</p>
                        <p className="empty-subtext">Completed transfers will appear here</p>
                    </div>
                ) : (
                    renderFiles(files, false)
                )}
            </section>
        </div>
    );
}
