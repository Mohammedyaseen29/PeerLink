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
    onDownload: (file: FileMetadata) => void;
    onPreview: (file: FileMetadata) => void;
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
    onDownload,
    onPreview,
    onClearRoom,
}: ReceivedFilesProps) {
    return (
        <div className="received-files glass-card">
            <div className="section-header">
                <h3 className="section-title">Received Files</h3>
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
                    <p>No files received yet</p>
                    <p className="empty-subtext">Files will appear here when shared</p>
                </div>
            ) : (
                <div className="files-list">
                    {files.map((file) => {
                        const iconType = getFileIconType(file.mimeType);
                        const Icon = fileIcons[iconType as keyof typeof fileIcons] || File;

                        return (
                            <div key={file.fileId} className="file-item">
                                <div className="file-icon">
                                    <Icon size={24} />
                                </div>

                                <div className="file-info">
                                    <span className="file-name">{file.name}</span>
                                    {file.path && (
                                        <span className="file-path">{file.path}</span>
                                    )}
                                    <span className="file-size">{formatBytes(file.size)}</span>
                                </div>

                                <div className="file-actions">
                                    <button
                                        onClick={() => onDownload(file)}
                                        className="btn btn-primary btn-sm"
                                    >
                                        <Download size={16} />
                                        <span>Download</span>
                                    </button>
                                    {isPreviewable(file.mimeType) && (
                                        <button
                                            onClick={() => onPreview(file)}
                                            className="btn btn-secondary btn-sm"
                                        >
                                            <Eye size={16} />
                                            <span>Preview</span>
                                        </button>
                                    )}
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
